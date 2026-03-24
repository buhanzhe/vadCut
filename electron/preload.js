'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vadCut', {
  openFolder:       () => ipcRenderer.invoke('dialog:openFolder'),
  shellOpenFolder:  (p) => ipcRenderer.invoke('shell:openFolder', p),
  startProcess:     (folderPath, options) => ipcRenderer.invoke('process:start', folderPath, options),
  cancelProcess:    () => ipcRenderer.invoke('process:cancel'),
  getSubtitleSchemeStatuses: () => ipcRenderer.invoke('subtitleSchemes:listStatuses'),
  getCurrentSubtitleScheme:  () => ipcRenderer.invoke('subtitleSchemes:getCurrent'),
  setCurrentSubtitleScheme:  (schemeId) => ipcRenderer.invoke('subtitleSchemes:setCurrent', schemeId),
  downloadSubtitleScheme:    (schemeId) => ipcRenderer.invoke('subtitleSchemes:download', schemeId),
  cancelSubtitleSchemeDownload: (schemeId) => ipcRenderer.invoke('subtitleSchemes:cancelDownload', schemeId),

  // 兼容旧调用，默认映射到 Paraformer 方案。
  getAsrEngineStatus:       () => ipcRenderer.invoke('engine:getStatus'),
  startAsrEngineDownload:   () => ipcRenderer.invoke('engine:download'),
  cancelAsrEngineDownload:  () => ipcRenderer.invoke('engine:cancelDownload'),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose:    () => ipcRenderer.send('window:close'),

  on: (channel, fn) => {
    const allowed = [
      'process:scan', 'process:fileStart', 'process:fileLog',
      'process:fileStage', 'process:fileDone', 'process:fileError',
      'process:allDone', 'window:maximized',
      'engine:downloadProgress', 'engine:downloadState',
      'subtitleSchemes:downloadProgress', 'subtitleSchemes:downloadState',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => fn(...args));
    }
  },

  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
