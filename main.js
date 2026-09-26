'use strict';

const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');

/** @type {BrowserWindow|null} */
let win = null;

/**
 * 设置内容区尺寸，并修正 DPI 取整误差。
 *
 * 无边框窗口在非整数缩放下（例如 150% DPI）`setContentSize(N)` 可能得到 N+1，
 * 会让页面出现 0.5px 的半像素偏移。这里测出偏差后反向补偿一次即可收敛。
 */
function applyContentSize(width, height) {
  win.setContentSize(width, height);
  const [aw, ah] = win.getContentSize();
  const dw = aw - width;
  const dh = ah - height;
  if (dw || dh) win.setContentSize(width - dw, height - dh);
}

// 无系统边框，所以窗口尺寸完全由渲染进程测得的 #app 尺寸决定
ipcMain.on('resize-window', (_event, width, height) => {
  if (!win || win.isDestroyed()) return;
  const w = Math.max(120, Math.round(width));
  const h = Math.max(120, Math.round(height));
  const [cw, ch] = win.getContentSize();
  if (cw !== w || ch !== h) applyContentSize(w, h);
});

// 自绘关闭按钮
ipcMain.on('close-window', () => {
  if (win && !win.isDestroyed()) win.close();
});

function createWindow() {
  win = new BrowserWindow({
    width: 550,
    height: 600,
    useContentSize: true,
    show: false,
    resizable: false,
    frame: false,           // 无边框，用页面内自绘的 × 关闭
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#faf8ef',
    title: '夯048 · Hang2048',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 首帧由渲染进程测量真实尺寸后回调 resize-window，这里兜底显示
  win.once('ready-to-show', () => win.show());
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 3000);

  win.on('closed', () => {
    win = null;
  });
}

// 单实例：再次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.hytools.hang2048');
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
