'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vadCut', {
  openFolder:       () => ipcRenderer.invoke('dialog:openFolder'),
  shellOpenFolder:  (p) => ipcRenderer.invoke('shell:openFolder', p),
  startProcess:     (folderPath, options) => ipcRenderer.invoke('process:start', folderPath, options),
  cancelProcess:    () => ipcRenderer.invoke('process:cancel'),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose:    () => ipcRenderer.send('window:close'),

  on: (channel, fn) => {
    const allowed = [
      'process:scan', 'process:fileStart', 'process:fileLog',
      'process:fileStage', 'process:fileDone', 'process:fileError',
      'process:allDone', 'window:maximized',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => fn(...args));
    }
  },

  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
