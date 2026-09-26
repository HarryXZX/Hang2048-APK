'use strict';

/**
 * 由项目根的 icon.png 生成 Android 各密度 mipmap 图标。
 *
 * 纯 Node 实现，不依赖 Electron / 任何第三方库：
 *   · 自己解析 PNG（zlib + 反滤波）
 *   · 用 box filter 做高质量降采样
 *   · 自己编码 PNG（与 make-icon 同一套思路）
 *
 *   node tools/make-android-icons.cjs
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ========================= PNG 解码 ========================= */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error('只支持 8 位深度，实际 ' + bitDepth);
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的色彩类型 ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // 反滤波
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? dst[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = (up && x >= channels) ? up[x - channels] : 0;
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('未知滤波器 ' + filter);
      }
      dst[x] = v & 0xff;
    }
  }

  // 统一转成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (channels === 1) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = out[s + 1];
    } else if (channels === 3) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2];
      rgba[d + 3] = 255;
    } else {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1];
      rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3];
    }
  }

  return { width, height, data: rgba };
}

/* ========================= 缩放（box filter） ========================= */

function resize(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yRatio);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xRatio);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((dx + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * sw + sx) * 4;
          // 预乘 alpha，避免边缘出现黑边
          const al = src[s + 3] / 255;
          r += src[s] * al;
          g += src[s + 1] * al;
          b += src[s + 2] * al;
          a += src[s + 3];
          n++;
        }
      }
      const d = (dy * dw + dx) * 4;
      const alphaSum = a / 255;
      if (alphaSum > 0) {
        dst[d] = Math.round(r / alphaSum);
        dst[d + 1] = Math.round(g / alphaSum);
        dst[d + 2] = Math.round(b / alphaSum);
      }
      dst[d + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/* ========================= PNG 编码 ========================= */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ========================= 主流程 ========================= */

const DENSITIES = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 }
];

const root = path.join(__dirname, '..');
const srcPng = path.join(root, 'icon.png');
const resDir = path.join(root, 'android', 'app', 'src', 'main', 'res');

if (!fs.existsSync(srcPng)) {
  console.error('找不到源图标: ' + srcPng);
  process.exit(1);
}

const src = decodePng(fs.readFileSync(srcPng));
console.log(`源图标 ${src.width}x${src.height}`);

for (const d of DENSITIES) {
  const dir = path.join(resDir, d.dir);
  fs.mkdirSync(dir, { recursive: true });

  const scaled = resize(src.data, src.width, src.height, d.size, d.size);
  const buf = encodePng(scaled, d.size, d.size);

  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), buf);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), buf);
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), buf);

  console.log(`  ${d.dir.padEnd(18)} ${String(d.size).padStart(3)}x${d.size}  ${(buf.length / 1024).toFixed(1)} KB`);
}

console.log('完成');
