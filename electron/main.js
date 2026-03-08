'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let cancelSignal = { cancelled: false };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 520,
    title: 'VAD-Cut 课程视频剪辑',
    ...(fs.existsSync(path.join(__dirname, '..', 'renderer', 'icon.png'))
      ? { icon: path.join(__dirname, '..', 'renderer', 'icon.png') }
      : {}),
    backgroundColor: '#00000000',
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ──────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件夹',
    properties: ['openDirectory'],
  });
  if (result.cancelled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openFolder', async (_event, folderPath) => {
  if (fs.existsSync(folderPath)) shell.openPath(folderPath);
});

ipcMain.handle('process:start', async (_event, folderPath, options = {}) => {
  if (!folderPath || !fs.existsSync(folderPath)) return { error: '文件夹路径无效' };

  cancelSignal = { cancelled: false };
  const { processFolder } = require('../src/processor');

  try {
    await processFolder(
      folderPath,
      {
        onScan(files)              { mainWindow?.webContents.send('process:scan', files); },
        onFileStart(index, filePath) { mainWindow?.webContents.send('process:fileStart', { index, filePath }); },
        onFileLog(index, msg)      { mainWindow?.webContents.send('process:fileLog', { index, msg }); },
        onFileStage(index, stage, pct) { mainWindow?.webContents.send('process:fileStage', { index, stage, pct }); },
        onFileDone(index, result)  { mainWindow?.webContents.send('process:fileDone', { index, result }); },
        onFileError(index, errMsg) { mainWindow?.webContents.send('process:fileError', { index, errMsg }); },
        onAllDone(summary)         { mainWindow?.webContents.send('process:allDone', summary); },
      },
      cancelSignal,
      options
    );
  } catch (err) {
    mainWindow?.webContents.send('process:allDone', { error: err.message });
  }

  return { ok: true };
});

ipcMain.handle('process:cancel', () => {
  cancelSignal.cancelled = true;
  return { ok: true };
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
