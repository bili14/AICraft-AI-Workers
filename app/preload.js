// preload.js — 安全桥：渲染进程通过 window.aicraft 访问后端 API 与本机能力
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aicraft', {
  // 后端 API 代理（经主进程转发到 center，端口随 center 顺延）
  api: (method, p, body) => ipcRenderer.invoke('api', method, p, body),
  // 本机能力（终态屏/帮助页用）
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  showItem: (p) => ipcRenderer.invoke('show-item', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyText: (t) => ipcRenderer.invoke('copy-text', t),
  readTail: (filePath, maxLines) => ipcRenderer.invoke('read-tail', filePath, maxLines),
  // 主进程 → 渲染层事件
  on: (channel, cb) => ipcRenderer.on(channel, (e, data) => cb(data)),
  // 渲染层 → 主进程：强制退出（小条上“强制退出”二次确认后调用）
  forceQuit: () => ipcRenderer.send('force-quit'),
});
