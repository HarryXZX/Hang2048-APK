'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** 把渲染进程测得的真实内容尺寸同步给窗口 */
  resize(width, height) {
    ipcRenderer.send('resize-window', width, height);
  },
  /** 关闭窗口（无边框窗口的自绘 × 按钮用） */
  closeWindow() {
    ipcRenderer.send('close-window');
  }
});
