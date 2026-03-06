'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 防止 Electron 在 packaged app 中找不到 native 模块
// sherpa-onnx / ffmpeg-static 需要从 app root 解析
if (app.isPackaged) {
  process.chdir(path.dirname(app.getPath('exe')));
}

let mainWindow = null;
// 用于取消正在进行的处理
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
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // 隐藏菜单栏
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // 处理拖拽文件夹启动（bat传参）
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const folderArg = args.find(a => {
    try { return fs.statSync(a).isDirectory(); } catch { return false; }
  });
  if (folderArg) {
    // 等待渲染进程准备好再发送
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('init:folder', folderArg);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ──────────────────────────────────────────────────────────

/**
 * 打开文件夹选择对话框
 */
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件夹',
    properties: ['openDirectory'],
  });
  if (result.cancelled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * 用资源管理器打开文件夹
 */
ipcMain.handle('shell:openFolder', async (_event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
  }
});

/**
 * 开始处理文件夹
 */
ipcMain.handle('process:start', async (_event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { error: '文件夹路径无效' };
  }

  cancelSignal = { cancelled: false };

  const { processFolder } = require('../src/processor');

  try {
    await processFolder(
      folderPath,
      {
        onScan(files) {
          mainWindow?.webContents.send('process:scan', files);
        },
        onFileStart(index, filePath) {
          mainWindow?.webContents.send('process:fileStart', { index, filePath });
        },
        onFileLog(index, msg) {
          mainWindow?.webContents.send('process:fileLog', { index, msg });
        },
        onFileStage(index, stage, pct) {
          mainWindow?.webContents.send('process:fileStage', { index, stage, pct });
        },
        onFileDone(index, result) {
          mainWindow?.webContents.send('process:fileDone', { index, result });
        },
        onFileError(index, errMsg) {
          mainWindow?.webContents.send('process:fileError', { index, errMsg });
        },
        onAllDone(summary) {
          mainWindow?.webContents.send('process:allDone', summary);
        },
      },
      cancelSignal
    );
  } catch (err) {
    mainWindow?.webContents.send('process:allDone', { error: err.message });
  }

  return { ok: true };
});

/**
 * 取消处理
 */
ipcMain.handle('process:cancel', () => {
  cancelSignal.cancelled = true;
  return { ok: true };
});
