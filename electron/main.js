'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  DEFAULT_SUBTITLE_SCHEME_ID,
  DOWNLOAD_CANCELLED_CODE,
  downloadSubtitleScheme,
  getAllSubtitleSchemeStatuses,
  getCurrentSubtitleScheme,
  getSubtitleSchemeStatus,
  resolveSubtitleSchemeId,
  resolveSubtitleSchemeInfo,
  setCurrentSubtitleScheme,
} = require('../src/asrEngine');
const { runBatch } = require('../src/batchRunner');
const { processFolder, scanVideoFiles } = require('../src/processor');
const { createCancelledError } = require('../src/taskCancellation');

let mainWindow = null;
let schemeDownloadSignal = null;
let schemeDownloadRunning = false;
let schemeDownloadSchemeId = null;
let activeProcessJob = null;

const SUBTITLE_WORKER_PATH = path.join(__dirname, 'subtitle-worker.js');
const SUBTITLE_WORKER_READY_TIMEOUT_MS = 15000;
const SUBTITLE_WORKER_CANCEL_GRACE_MS = 2000;
const SUBTITLE_MAX_CONCURRENCY = 2;

app.commandLine.appendSwitch('lang', 'zh-CN');

function sendToRenderer(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function getSubtitleWorkerCwd() {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..');
}

function createRendererProcessCallbacks() {
  return {
    onScan(files) {
      sendToRenderer('process:scan', files);
    },
    onFileStart(index, filePath) {
      sendToRenderer('process:fileStart', { index, filePath });
    },
    onFileLog(index, msg) {
      sendToRenderer('process:fileLog', { index, msg });
    },
    onFileStage(index, stage, pct) {
      sendToRenderer('process:fileStage', { index, stage, pct });
    },
    onFileDone(index, result) {
      sendToRenderer('process:fileDone', { index, result });
    },
    onFileError(index, errMsg) {
      sendToRenderer('process:fileError', { index, errMsg });
    },
    onAllDone(summary) {
      sendToRenderer('process:allDone', summary);
    },
  };
}

function clearSubtitleWorkerKillTimer(job, child) {
  const timer = job?.workerKillTimers?.get(child);
  if (!timer) return;
  clearTimeout(timer);
  job.workerKillTimers.delete(child);
}

function trackProcessChild(job, child) {
  job?.children?.add(child);
}

function untrackProcessChild(job, child) {
  clearSubtitleWorkerKillTimer(job, child);
  job?.children?.delete(child);
}

function killTrackedChildren(job) {
  if (!job?.children) return;
  for (const child of Array.from(job.children)) {
    clearSubtitleWorkerKillTimer(job, child);
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (_) {}
    }
  }
  job.children.clear();
  job.workerKillTimers.clear();
}

function finalizeProcessJob(job) {
  killTrackedChildren(job);
  if (activeProcessJob === job) {
    activeProcessJob = null;
  }
}

function requestProcessCancellation(job) {
  if (!job) return;

  job.signal.cancelled = true;
  if (job.kind !== 'subtitle') {
    return;
  }

  for (const child of Array.from(job.children)) {
    if (child.connected) {
      try {
        child.send({ type: 'cancel' });
      } catch (_) {}
    }

    clearSubtitleWorkerKillTimer(job, child);
    const killTimer = setTimeout(() => {
      if (activeProcessJob === job && job.children.has(child) && !child.killed) {
        try {
          child.kill();
        } catch (_) {}
      }
    }, SUBTITLE_WORKER_CANCEL_GRACE_MS);
    job.workerKillTimers.set(child, killTimer);
  }
}

function startBackgroundProcess(job, runner) {
  void (async () => {
    try {
      await runner();
    } catch (err) {
      sendToRenderer('process:allDone', {
        error: err?.message || '处理失败',
      });
    } finally {
      finalizeProcessJob(job);
    }
  })();
}

async function runSubtitleWorkerTask(videoPath, index, subtitleScheme, job) {
  return new Promise((resolve, reject) => {
    const childProcessPath = process.execPath;
    const workerCwd = getSubtitleWorkerCwd();
    const child = spawn(process.execPath, [SUBTITLE_WORKER_PATH], {
      cwd: workerCwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        VADCUT_APP_PACKAGED: app.isPackaged ? '1' : '0',
        VADCUT_RESOURCES_PATH: process.resourcesPath || '',
        VADCUT_USER_DATA_PATH: app.getPath('userData'),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });

    trackProcessChild(job, child);

    let settled = false;
    let stderr = '';
    let readyReceived = false;

    const readyTimer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch (_) {}
      finish(reject, new Error('字幕子进程启动超时'));
    }, SUBTITLE_WORKER_READY_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(readyTimer);
      untrackProcessChild(job, child);
    }

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) {
        stderr = stderr.slice(-4096);
      }
    });

    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;

      switch (message.type) {
        case 'ready':
          readyReceived = true;
          clearTimeout(readyTimer);
          if (job.signal.cancelled) {
            requestProcessCancellation(job);
            return;
          }
          if (child.connected) {
            child.send({
              type: 'start',
              videoPath,
              schemeId: subtitleScheme.schemeId,
            });
          }
          return;
        case 'log':
          sendToRenderer('process:fileLog', {
            index,
            msg: String(message.msg || ''),
          });
          return;
        case 'stage':
        case 'progress':
          sendToRenderer('process:fileStage', {
            index,
            stage: String(message.stage || 'asr'),
            pct: Number(message.pct || 0),
          });
          return;
        case 'done':
          finish(resolve, message.result || null);
          return;
        case 'cancelled':
          finish(reject, createCancelledError(message.message || '字幕提取已取消'));
          return;
        case 'error':
          finish(reject, new Error(message.error || '字幕提取失败'));
          return;
        default:
          return;
      }
    });

    child.on('error', (err) => {
      if (err?.code === 'ENOENT') {
        finish(
          reject,
          new Error(`字幕子进程启动失败: exec=${childProcessPath}, script=${SUBTITLE_WORKER_PATH}, cwd=${workerCwd}`)
        );
        return;
      }
      finish(reject, err);
    });

    child.on('exit', (code, signalName) => {
      if (settled) return;
      if (job.signal.cancelled) {
        finish(reject, createCancelledError('字幕提取已取消'));
        return;
      }
      if (!readyReceived) {
        finish(reject, new Error('字幕子进程启动失败'));
        return;
      }

      const stderrText = stderr.trim();
      const stderrSuffix = stderrText
        ? `：${stderrText.split(/\r?\n/).slice(-3).join(' ')}`
        : '';
      const signalSuffix = signalName ? `, signal=${signalName}` : '';
      finish(
        reject,
        new Error(`字幕子进程异常退出（code=${code}${signalSuffix}）${stderrSuffix}`)
      );
    });

    if (job.signal.cancelled) {
      requestProcessCancellation(job);
    }
  });
}

async function runSubtitleFolderJob(folderPath, options, job) {
  const callbacks = createRendererProcessCallbacks();
  const videoFiles = scanVideoFiles(folderPath);
  const subtitleScheme = resolveSubtitleSchemeInfo(options.subtitleScheme);

  callbacks.onScan(videoFiles);

  if (videoFiles.length === 0) {
    callbacks.onAllDone({ total: 0, success: 0, skipped: 0, errors: 0 });
    return;
  }

  const concurrency = Math.min(SUBTITLE_MAX_CONCURRENCY, videoFiles.length);
  callbacks.onFileLog(-1, `并发数: ${concurrency}`);
  callbacks.onFileLog(-1, `字幕方案: ${subtitleScheme.label}`);

  const summary = await runBatch({
    files: videoFiles,
    concurrency,
    signal: job.signal,
    onFileStart: callbacks.onFileStart,
    onFileDone: callbacks.onFileDone,
    onFileError: callbacks.onFileError,
    onFileLog: callbacks.onFileLog,
    runFile: ({ index, filePath }) => runSubtitleWorkerTask(filePath, index, subtitleScheme, job),
  });

  if (job.signal.cancelled) {
    callbacks.onFileLog(-1, '任务已取消，已停止后续文件');
  }

  callbacks.onAllDone({
    ...summary,
    outputDir: folderPath,
    subtitleSchemeId: subtitleScheme.schemeId,
    subtitleSchemeLabel: subtitleScheme.label,
  });
}

function startProcessJob(folderPath, options) {
  if (activeProcessJob) {
    return { error: '已有任务正在处理中，请稍候。' };
  }

  const job = {
    kind: options.subtitleOnly ? 'subtitle' : (options.transcodeOnly ? 'transcode' : 'clip'),
    signal: { cancelled: false },
    children: new Set(),
    workerKillTimers: new Map(),
  };
  activeProcessJob = job;

  if (options.subtitleOnly) {
    startBackgroundProcess(job, () => runSubtitleFolderJob(folderPath, options, job));
  } else {
    startBackgroundProcess(job, () => (
      processFolder(folderPath, createRendererProcessCallbacks(), job.signal, options)
    ));
  }

  return { ok: true };
}

function startSubtitleSchemeDownload(schemeId) {
  const resolvedSchemeId = resolveSubtitleSchemeId(schemeId || getCurrentSubtitleScheme());
  const schemeInfo = resolveSubtitleSchemeInfo(resolvedSchemeId);

  if (schemeDownloadRunning) {
    if (schemeDownloadSchemeId === resolvedSchemeId) {
      return { ok: true, running: true, schemeId: resolvedSchemeId };
    }
    return {
      ok: false,
      running: true,
      schemeId: schemeDownloadSchemeId,
      error: '已有其他字幕方案正在下载中',
    };
  }

  schemeDownloadRunning = true;
  schemeDownloadSchemeId = resolvedSchemeId;
  schemeDownloadSignal = { cancelled: false };
  sendToRenderer('subtitleSchemes:downloadState', {
    schemeId: resolvedSchemeId,
    state: 'starting',
    message: `开始下载 ${schemeInfo.label}...`,
  });

  downloadSubtitleScheme(resolvedSchemeId, {
    signal: schemeDownloadSignal,
    onStatus(message) {
      sendToRenderer('subtitleSchemes:downloadState', {
        schemeId: resolvedSchemeId,
        state: 'downloading',
        message,
      });
    },
    onProgress(progress) {
      sendToRenderer('subtitleSchemes:downloadProgress', progress);
      if (resolvedSchemeId === DEFAULT_SUBTITLE_SCHEME_ID) {
        sendToRenderer('engine:downloadProgress', progress);
      }
    },
  })
    .then((status) => {
      const message = `${status.label} 下载完成`;
      sendToRenderer('subtitleSchemes:downloadState', {
        schemeId: resolvedSchemeId,
        state: 'completed',
        status,
        message,
      });
      if (resolvedSchemeId === DEFAULT_SUBTITLE_SCHEME_ID) {
        sendToRenderer('engine:downloadState', { state: 'completed', status, message });
      }
    })
    .catch((err) => {
      if (err && err.code === DOWNLOAD_CANCELLED_CODE) {
        sendToRenderer('subtitleSchemes:downloadState', {
          schemeId: resolvedSchemeId,
          state: 'cancelled',
          message: '下载已取消',
        });
        if (resolvedSchemeId === DEFAULT_SUBTITLE_SCHEME_ID) {
          sendToRenderer('engine:downloadState', { state: 'cancelled', message: '下载已取消' });
        }
      } else {
        const message = err?.message || `${schemeInfo.label} 下载失败`;
        sendToRenderer('subtitleSchemes:downloadState', {
          schemeId: resolvedSchemeId,
          state: 'failed',
          message,
        });
        if (resolvedSchemeId === DEFAULT_SUBTITLE_SCHEME_ID) {
          sendToRenderer('engine:downloadState', { state: 'failed', message });
        }
      }
    })
    .finally(() => {
      schemeDownloadRunning = false;
      schemeDownloadSignal = null;
      schemeDownloadSchemeId = null;
    });

  if (resolvedSchemeId === DEFAULT_SUBTITLE_SCHEME_ID) {
    sendToRenderer('engine:downloadState', {
      state: 'starting',
      message: `开始下载 ${schemeInfo.label}...`,
    });
  }

  return { ok: true, running: false, schemeId: resolvedSchemeId };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 520,
    title: 'VAD-Cut 课程视频处理',
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

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  requestProcessCancellation(activeProcessJob);
  killTrackedChildren(activeProcessJob);
  if (schemeDownloadSignal) {
    schemeDownloadSignal.cancelled = true;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件夹',
    properties: ['openDirectory'],
  });
  if (result.cancelled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openFolder', async (_event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
  }
});

ipcMain.handle('process:start', async (_event, folderPath, options = {}) => {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { error: '文件夹路径无效' };
  }

  if (options.subtitleOnly) {
    const schemeId = resolveSubtitleSchemeId(options.subtitleScheme || getCurrentSubtitleScheme());
    const status = getSubtitleSchemeStatus(schemeId);
    if (!status.ready) {
      return {
        error: `${status.label} 未就绪，请先下载当前方案（缺少: ${status.missingFiles.join(', ')}）`,
      };
    }

    options = {
      ...options,
      subtitleScheme: schemeId,
    };
    setCurrentSubtitleScheme(schemeId);
  }

  return startProcessJob(folderPath, options);
});

ipcMain.handle('process:cancel', () => {
  requestProcessCancellation(activeProcessJob);
  return { ok: true };
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('engine:getStatus', () => getSubtitleSchemeStatus(DEFAULT_SUBTITLE_SCHEME_ID));

ipcMain.handle('engine:download', async () => startSubtitleSchemeDownload(DEFAULT_SUBTITLE_SCHEME_ID));

ipcMain.handle('engine:cancelDownload', () => {
  if (schemeDownloadSignal && schemeDownloadSchemeId === DEFAULT_SUBTITLE_SCHEME_ID) {
    schemeDownloadSignal.cancelled = true;
  }
  return { ok: true };
});

ipcMain.handle('subtitleSchemes:listStatuses', () => getAllSubtitleSchemeStatuses());

ipcMain.handle('subtitleSchemes:getCurrent', () => resolveSubtitleSchemeInfo(getCurrentSubtitleScheme()));

ipcMain.handle('subtitleSchemes:setCurrent', (_event, schemeId) => setCurrentSubtitleScheme(schemeId));

ipcMain.handle('subtitleSchemes:download', async (_event, schemeId) => startSubtitleSchemeDownload(schemeId));

ipcMain.handle('subtitleSchemes:cancelDownload', (_event, schemeId) => {
  if (schemeDownloadSignal) {
    const targetSchemeId = resolveSubtitleSchemeId(schemeId || schemeDownloadSchemeId);
    if (!schemeDownloadSchemeId || targetSchemeId === schemeDownloadSchemeId) {
      schemeDownloadSignal.cancelled = true;
    }
  }
  return { ok: true };
});
