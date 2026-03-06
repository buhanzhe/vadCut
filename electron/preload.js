'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vadCut', {
  // 打开文件夹对话框，返回路径字符串或 null
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // 用资源管理器打开文件夹
  shellOpenFolder: (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath),

  // 开始处理
  startProcess: (folderPath) => ipcRenderer.invoke('process:start', folderPath),

  // 取消处理
  cancelProcess: () => ipcRenderer.invoke('process:cancel'),

  // 监听主进程推送的事件
  on: (channel, fn) => {
    const allowed = [
      'process:scan',
      'process:fileStart',
      'process:fileLog',
      'process:fileStage',
      'process:fileDone',
      'process:fileError',
      'process:allDone',
      'init:folder',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => fn(...args));
    }
  },

  // 移除监听
  off: (channel, fn) => {
    ipcRenderer.removeListener(channel, fn);
  },

  // 移除该 channel 所有监听
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
