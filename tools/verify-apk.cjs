'use strict';

/**
 * APK 静态验证：不依赖模拟器/真机，直接解包检查产物是否符合预期。
 *
 *   node tools/verify-apk.cjs [apk路径]
 *
 * 检查项：
 *   · 包名 / 版本 / minSdk / targetSdk
 *   · 权限清单（必须只有 VIBRATE，绝不能有 INTERNET / 存储）
 *   · assets 内的 Web 资源是否齐全且与源文件一致
 *   · 五个密度的启动图标是否存在
 *   · 签名是否存在（读取 META-INF 或 v2 签名块）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const apkPath = process.argv[2] || path.join(ROOT, 'output', 'Hang2048-1.0.0-release.apk');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '   ' + extra : '')); }
}

if (!fs.existsSync(apkPath)) {
  console.error('找不到 APK: ' + apkPath);
  process.exit(1);
}

const apk = fs.readFileSync(apkPath);
console.log('APK: ' + apkPath);
console.log('大小: ' + (apk.length / 1048576).toFixed(2) + ' MB\n');

/* ---------------- 解析 ZIP 中央目录 ---------------- */
function listZipEntries(buf) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/APK');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('坏 local header: ' + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

const entries = listZipEntries(apk);
const byName = new Map(entries.map((e) => [e.name, e]));

console.log('=== 1. 签名 ===');
const v2 = apk.includes(Buffer.from('APK Sig Block 42', 'ascii'));
check('存在 v2 签名块', v2, '（v2 覆盖 minSdk 24 起的全部设备）');

console.log('\n=== 2. Web 资源（assets）===');
const assetsDir = path.join(ROOT, 'renderer');
const expected = ['index.html', 'styles.css', 'renderer.js'];
for (const f of expected) {
  const e = byName.get('assets/' + f);
  const srcPath = path.join(assetsDir, f);
  if (!e) { check('assets/' + f, false, '缺失'); continue; }
  const packed = readEntry(apk, e);
  const src = fs.readFileSync(srcPath);
  const same = packed.length === src.length && packed.equals(src);
  check('assets/' + f + ' 与源文件一致', same,
    same ? `${packed.length} B` : `包内 ${packed.length} B vs 源 ${src.length} B`);
}

console.log('\n=== 3. 启动图标 ===');
const icons = entries.filter((e) => /^res\/.*\.png$/i.test(e.name) && e.uncompSize > 1000);
check('存在多密度图标资源', icons.length >= 5, `候选 png: ${icons.length}`);
// 按大小比对：我们的五张图标体积各不相同
const srcIconSizes = [48, 72, 96, 144, 192].map((s) => {
  const p = path.join(ROOT, 'android', 'app', 'src', 'main', 'res',
    'mipmap-' + { 48: 'mdpi', 72: 'hdpi', 96: 'xhdpi', 144: 'xxhdpi', 192: 'xxxhdpi' }[s],
    'ic_launcher.png');
  return fs.existsSync(p) ? fs.statSync(p).size : -1;
});
let matched = 0;
for (const s of srcIconSizes) {
  if (s > 0 && entries.some((e) => e.uncompSize === s)) matched++;
}
check('五张启动图标全部打包', matched === 5, `匹配 ${matched}/5`);

console.log('\n=== 4. 权限与包信息（用 aapt2 解析二进制 XML）===');
// AndroidManifest 在 APK 里是二进制 XML，字符串按 UTF-16 存放，
// 直接搜字节是找不到的 —— 必须用 aapt2 解析。
function findAapt2() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const bt = path.join(sdk, 'build-tools');
  if (!fs.existsSync(bt)) return null;
  const versions = fs.readdirSync(bt).sort().reverse();
  for (const v of versions) {
    const p = path.join(bt, v, 'aapt2.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const aapt2 = findAapt2();
let badging = null;
if (aapt2) {
  try {
    badging = execFileSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  } catch (e) { badging = null; }
}

if (!badging) {
  check('aapt2 可用（解析二进制 Manifest）', false,
    '找不到 aapt2，请设置 ANDROID_HOME');
} else {
  const perms = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
  const hasVibrate = perms.includes('android.permission.VIBRATE');
  const hasInternet = perms.includes('android.permission.INTERNET');
  const hasStorage = perms.some((p) => /STORAGE/.test(p));
  const hasNetState = perms.includes('android.permission.ACCESS_NETWORK_STATE');

  check('声明了 VIBRATE（震动反馈）', hasVibrate);
  check('没有 INTERNET 权限', !hasInternet);
  check('没有存储权限', !hasStorage);
  check('没有 ACCESS_NETWORK_STATE', !hasNetState);
  check('权限总数仅 1 个业务权限', perms.filter((p) => p.startsWith('android.permission')).length === 1,
    perms.join(', '));

  const pkg = /package: name='([^']+)'/.exec(badging);
  check('包名为 com.hytools.hang2048.apk', pkg && pkg[1] === 'com.hytools.hang2048.apk',
    pkg ? pkg[1] : '未解析出');

  // 注意 aapt2 输出的是 minSdkVersion:'24'，不是 sdkVersion
  const minSdk = /minSdkVersion:'(\d+)'/.exec(badging);
  const targetSdk = /targetSdkVersion:'(\d+)'/.exec(badging);
  check('minSdk = 24（Android 7.0）', minSdk && minSdk[1] === '24', minSdk ? minSdk[1] : '?');
  check('targetSdk = 36', targetSdk && targetSdk[1] === '36', targetSdk ? targetSdk[1] : '?');

  const label = /application-label:'([^']+)'/.exec(badging);
  check('应用名为「夯048」', label && label[1] === '夯048', label ? label[1] : '?');

  const iconCount = (badging.match(/application-icon-\d+:/g) || []).length;
  check('五个密度的应用图标已注册', iconCount >= 5, `application-icon-* = ${iconCount}`);
}
console.log('\n=== 5. 不含外部网络引用 ===');
const idxEntry = byName.get('assets/index.html');
if (idxEntry) {
  const html = readEntry(apk, idxEntry).toString('utf8');
  const hasHttp = /https?:\/\//i.test(html);
  check('index.html 无外部 URL', !hasHttp);
  check('index.html 含 CSP', html.includes('Content-Security-Policy'));
}
const jsEntry = byName.get('assets/renderer.js');
if (jsEntry) {
  const js = readEntry(apk, jsEntry).toString('utf8');
  check('renderer.js 无外部 URL', !/https?:\/\//i.test(js));
  check('renderer.js 含震动接口', js.includes('vibrate'));
  check('renderer.js 含返回键处理', js.includes('onBackKey'));
  check('renderer.js 含响应式布局', js.includes('function layout'));
  check('renderer.js 含多指过滤', js.includes('activePointerId'));
}

console.log('');
console.log(fail === 0 ? `全部通过 ✅  (${pass} 项)` : `${fail} 项失败 ❌  (通过 ${pass} 项)`);
process.exit(fail === 0 ? 0 : 1);
