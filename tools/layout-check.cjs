'use strict';

/**
 * 响应式布局验证：模拟多种手机/平板屏幕尺寸，检查布局是否合理。
 *   electron tools/layout-check.cjs
 *
 * 用 Electron 的窗口尺寸模拟不同设备，截图输出到 captures/layout/。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'captures', 'layout');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
}

// 常见机型的 CSS 像素尺寸（竖屏）
const DEVICES = [
  { name: 'iPhone-SE', w: 375, h: 667, note: '小屏基准' },
  { name: 'iPhone-14', w: 390, h: 844, note: '主流 iPhone' },
  { name: 'Pixel-7', w: 412, h: 915, note: '主流 Android' },
  { name: 'Galaxy-S23U', w: 384, h: 824, note: '三星大屏' },
  { name: 'Xiaomi-13', w: 393, h: 873, note: '小米' },
  { name: 'Huawei-Mate', w: 360, h: 780, note: '华为窄屏' },
  { name: 'Narrow', w: 320, h: 568, note: '极窄屏（iPhone 5）' },
  { name: 'Tablet', w: 800, h: 1280, note: '平板' },
  { name: 'Landscape', w: 844, h: 390, note: '横屏' }
];

let win = null;

ipcMain.on('resize-window', () => { /* 本脚本不跟随内容尺寸，忽略 */ });

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 390,
    height: 844,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#faf8ef',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const level = ev && typeof ev === 'object' && 'level' in ev ? ev.level : args[1];
    const message = ev && typeof ev === 'object' && 'message' in ev ? ev.message : args[2];
    if (level === 'error' || level === 3) errors.push(String(message));
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.showInactive();
  await sleep(600);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // 真机是触屏环境（body.is-touch），关闭按钮会被隐藏。
  // 桌面预览壳下 IS_TOUCH 为 false，为了还原真机布局，这里手动打上标记。
  await js(`(function () { document.body.classList.add('is-touch'); return true; })()`);
  await sleep(120);

  for (const d of DEVICES) {
    win.setContentSize(d.w, d.h);
    await sleep(320);
    // 触发 resize 后布局会延迟 120ms 重算，多等一会
    await sleep(220);

    const m = await js(`(() => {
      const ms = window.__h2048;
      const board = document.getElementById('board').getBoundingClientRect();
      const header = document.querySelector('.header').getBoundingClientRect();
      const app = document.getElementById('app').getBoundingClientRect();
      const reset = document.getElementById('resetBtn').getBoundingClientRect();
      const closeBtn = document.getElementById('closeBtn');
      const closeVisible = getComputedStyle(closeBtn).display !== 'none';
      const close = closeBtn.getBoundingClientRect();
      const cs = getComputedStyle(document.getElementById('app'));
      const padL = parseFloat(cs.paddingLeft);
      const padR = parseFloat(cs.paddingRight);
      const cells = document.querySelectorAll('#grid .cell');
      const c0 = cells.length ? cells[0].getBoundingClientRect() : null;
      return {
        metrics: ms.getMetrics(),
        board: [board.width, board.height, board.left, board.top, board.bottom, board.right],
        header: [header.width, header.height, header.left, header.top],
        app: [app.width, app.height, app.left],
        padL, padR,
        reset: [reset.left, reset.top, reset.right, reset.bottom, reset.width],
        closeVisible,
        close: [close.left, close.top, close.right, close.bottom],
        cell: c0 ? [c0.width, c0.height, c0.left, c0.top] : null,
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        gridCount: cells.length,
        docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        docOverflowY: document.documentElement.scrollHeight - window.innerHeight
      };
    })()`);

    const { board, header, app, cell, innerW, innerH, metrics } = m;

    // 1) 棋盘不超出视口
    const fitsW = board[0] <= innerW + 0.6;
    const fitsH = board[4] <= innerH + 0.6;
    check(`${d.name} ${d.w}x${d.h} 棋盘不溢出视口`, fitsW && fitsH,
      `board=${board[0].toFixed(1)} bottom=${board[4].toFixed(1)} inner=${innerW}x${innerH}`);

    // 2) 棋盘在视口内且不被顶部栏压住
    check(`${d.name} 棋盘位于顶部栏下方`, board[3] >= header[3] + header[1] - 1,
      `boardTop=${board[3].toFixed(1)} headerBottom=${(header[3] + header[1]).toFixed(1)}`);

    // 3) 棋盘是正方形
    check(`${d.name} 棋盘为正方形`, Math.abs(board[0] - board[1]) < 0.6,
      `${board[0].toFixed(2)} x ${board[1].toFixed(2)}`);

    // 4) 格子尺寸在合理区间
    const okCell = metrics.cell >= 44 && metrics.cell <= 150;
    check(`${d.name} 格子尺寸合理`, okCell, `cell=${metrics.cell.toFixed(1)}`);

    // 5) 无横向/纵向溢出（不应出现滚动条）
    const noOverflow = m.docOverflowX <= 1 && m.docOverflowY <= 1;
    check(`${d.name} 无页面溢出`, noOverflow,
      `overflow=${m.docOverflowX}x${m.docOverflowY}`);

    // 6) 4x4 网格完整
    check(`${d.name} 网格 4x4 完整`, m.gridCount === 16, `count=${m.gridCount}`);

    // 7) 顶部栏应与棋盘左右对齐（都在 #app 的内容区里居中）
    const headerAligned = Math.abs(header[0] - board[0]) < 1.5 &&
      Math.abs(header[2] - board[2]) < 1.5;
    check(`${d.name} 顶部栏与棋盘左右对齐`, headerAligned,
      `header=[${header[0].toFixed(1)}@${header[2].toFixed(1)}] board=[${board[0].toFixed(1)}@${board[2].toFixed(1)}]`);

    // 8) 重置按钮不应与关闭按钮重叠（关闭按钮可见时）
    if (m.closeVisible) {
      const overlap = !(m.reset[2] <= m.close[0] || m.reset[0] >= m.close[2] ||
                        m.reset[3] <= m.close[1] || m.reset[1] >= m.close[3]);
      check(`${d.name} 重置按钮与关闭按钮不重叠`, !overlap,
        `reset=[${m.reset[0].toFixed(0)}..${m.reset[2].toFixed(0)}] close=[${m.close[0].toFixed(0)}..${m.close[2].toFixed(0)}]`);
    } else {
      check(`${d.name} 触屏下已隐藏关闭按钮`, true, 'close-btn display:none');
    }

    // 9) 棋盘应充分利用宽度（竖屏时不应明显小于可用宽度）
    const isPortrait = innerH > innerW;
    if (isPortrait && metrics.cell < 150) {
      const usage = board[0] / (innerW - m.padL - m.padR);
      check(`${d.name} 竖屏棋盘充分利用宽度`, usage > 0.95,
        `usage=${(usage * 100).toFixed(1)}% board=${board[0].toFixed(0)} avail=${(innerW - m.padL - m.padR).toFixed(0)}`);
    } else {
      check(`${d.name} 棋盘宽度利用（横屏/平板不强制）`, true, 'skip');
    }

    console.log(`        -> board=${board[0].toFixed(0)}px cell=${metrics.cell.toFixed(1)}px font=${metrics.font.toFixed(1)}px thresh=${metrics.dragThreshold.toFixed(1)}px`);

    if (d.name !== 'Landscape') {
      // 横屏单独截一张，其余逐张
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${d.name}.png`), img.toPNG());
  }

  check('渲染进程无错误日志', errors.length === 0, errors.join(' | '));

  console.log('');
  console.log(failures === 0 ? '布局全部通过 ✅' : failures + ' 项失败 ❌');
  console.log('截图: ' + OUT);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('LAYOUT CHECK CRASH', err);
  app.exit(2);
});
