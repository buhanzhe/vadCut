'use strict';

function formatElapsed(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}秒`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}分${s}秒`;
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  folderPath: null,
  files: [],          // [{ path, name, status, stageLabel, stagePct, logs, result }]
  running: false,
  outputDir: null,
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const dropzone          = $('#dropzone');
const toolbar           = $('#toolbar');
const folderPathEl      = $('#folder-path');
const btnChange         = $('#btn-change');
const btnStart          = $('#btn-start');
const btnCancel         = $('#btn-cancel');
const btnOpenOutput     = $('#btn-open-output');
const overallProgress   = $('#overall-progress');
const progressLabel     = $('#progress-label');
const progressCount     = $('#progress-count');
const progressBar       = $('#progress-bar');
const fileListSection   = $('#file-list-section');
const fileList          = $('#file-list');
const logSection        = $('#log-section');
const logPanel          = $('#log-panel');
const btnClearLog       = $('#btn-clear-log');

// ── Helpers ────────────────────────────────────────────────────────────────
function show(...els) { els.forEach(e => e.classList.remove('hidden')); }
function hide(...els) { els.forEach(e => e.classList.add('hidden')); }

function addLog(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  line.textContent = `[${ts}] ${msg}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function stageLabel(stage) {
  return { metadata: '读取元数据', audio: '提取音频', vad: 'VAD检测', trim: '剪辑视频' }[stage] || stage;
}

// ── File Item Rendering ────────────────────────────────────────────────────
function statusIcon(status) {
  switch (status) {
    case 'waiting':
      return `<svg class="file-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    case 'running':
      return `<span class="spinner file-status-icon"></span>`;
    case 'done':
      return `<svg class="file-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    case 'skip':
      return `<svg class="file-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    case 'error':
      return `<svg class="file-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    case 'copy':
      return `<svg class="file-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    default: return '';
  }
}

function badgeClass(status) {
  return { waiting: 'badge-waiting', running: 'badge-running', done: 'badge-done', skip: 'badge-skip', error: 'badge-error', copy: 'badge-copy' }[status] || 'badge-waiting';
}

function badgeText(file) {
  switch (file.status) {
    case 'waiting': return '等待中';
    case 'running': return file.stageLabel || '处理中';
    case 'done':    return file.result?.copied ? '已复制' : `切头${(file.result?.headCut||0).toFixed(1)}s 切尾${(file.result?.tailCut||0).toFixed(1)}s`;
    case 'skip':    return '已跳过';
    case 'error':   return '出错';
    case 'copy':    return '直接复制';
    default:        return '';
  }
}

function renderFileItem(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.id = `file-item-${index}`;
  el.innerHTML = buildFileItemHTML(file);
  return el;
}

function buildFileItemHTML(file) {
  const pct = file.stagePct ?? 0;
  const logText = file.logs.length ? file.logs[file.logs.length - 1] : '';
  const showBar = file.status === 'running';
  const resultText = file.status === 'done' && !file.result?.skipped
    ? (file.result?.copied
        ? '直接复制（无需剪辑）'
        : `已剪辑 → 切掉开头 ${(file.result?.headCut||0).toFixed(1)}s，结尾 ${(file.result?.tailCut||0).toFixed(1)}s`)
    : file.status === 'error' ? (file.errorMsg || '未知错误') : '';
  const resultClass = file.status === 'error' ? 'error' : '';

  return `
    <div class="file-item-header">
      ${statusIcon(file.status)}
      <span class="file-name" title="${escHtml(file.path)}">${escHtml(file.name)}</span>
      <span class="file-badge ${badgeClass(file.status)}">${escHtml(badgeText(file))}</span>
    </div>
    ${showBar ? `
    <div class="file-stage-bar">
      <div class="file-stage-fill" style="width:${pct}%"></div>
    </div>` : ''}
    ${logText ? `<div class="file-log">${escHtml(logText)}</div>` : ''}
    ${resultText ? `<div class="file-result ${resultClass}">${escHtml(resultText)}</div>` : ''}
  `;
}

function updateFileItem(index) {
  const el = document.getElementById(`file-item-${index}`);
  if (el) el.innerHTML = buildFileItemHTML(state.files[index]);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Overall Progress ───────────────────────────────────────────────────────
function updateOverallProgress() {
  const total = state.files.length;
  const done  = state.files.filter(f => ['done','skip','error'].includes(f.status)).length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  progressCount.textContent = `${done} / ${total}`;
  if (state.running) {
    const current = state.files.findIndex(f => f.status === 'running');
    progressLabel.textContent = current >= 0
      ? `正在处理: ${state.files[current].name}`
      : '处理中...';
  }
}

// ── Set Folder ─────────────────────────────────────────────────────────────
function setFolder(folderPath) {
  state.folderPath = folderPath;
  state.files = [];
  state.outputDir = null;

  folderPathEl.textContent = folderPath;
  hide(dropzone);
  show(toolbar);
  hide(overallProgress, fileListSection, logSection);
  hide(btnOpenOutput, btnCancel);
  show(btnStart);
  btnStart.disabled = false;

  fileList.innerHTML = '';
  logPanel.innerHTML = '';

  addLog(`已选择文件夹: ${folderPath}`);
  show(logSection);
}

// ── Start Processing ───────────────────────────────────────────────────────
function startProcessing() {
  if (!state.folderPath || state.running) return;
  state.running = true;
  state.files = [];
  state.outputDir = null;

  fileList.innerHTML = '';
  logPanel.innerHTML = '';

  hide(btnStart, btnOpenOutput);
  show(btnCancel, overallProgress, fileListSection, logSection);
  progressBar.style.width = '0%';
  progressLabel.textContent = '扫描文件...';
  progressCount.textContent = '';

  addLog('开始处理...', 'info');

  // 注册 IPC 事件
  registerIPCListeners();

  window.vadCut.startProcess(state.folderPath);
}

// ── IPC Event Listeners ────────────────────────────────────────────────────
function registerIPCListeners() {
  // 清理旧监听
  ['process:scan','process:fileStart','process:fileLog',
   'process:fileStage','process:fileDone','process:fileError','process:allDone']
    .forEach(ch => window.vadCut.removeAllListeners(ch));

  window.vadCut.on('process:scan', (files) => {
    if (files.length === 0) {
      addLog('未找到视频文件', 'warn');
      return;
    }
    addLog(`找到 ${files.length} 个视频文件`, 'info');
    state.files = files.map(fp => ({
      path: fp,
      name: fp.split(/[\\/]/).pop(),
      status: 'waiting',
      stageLabel: '',
      stagePct: 0,
      logs: [],
      result: null,
      errorMsg: null,
    }));
    fileList.innerHTML = '';
    state.files.forEach((f, i) => {
      fileList.appendChild(renderFileItem(f, i));
    });
    show(fileListSection);
    updateOverallProgress();
  });

  window.vadCut.on('process:fileStart', ({ index, filePath }) => {
    if (!state.files[index]) return;
    state.files[index].status = 'running';
    state.files[index].stagePct = 0;
    updateFileItem(index);
    updateOverallProgress();
    addLog(`▶ [${index + 1}] ${state.files[index].name}`);
    // 滚动到当前处理项
    const el = document.getElementById(`file-item-${index}`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  window.vadCut.on('process:fileLog', ({ index, msg }) => {
    // index === -1 表示全局日志（如耗时汇总），不关联具体文件
    if (index === -1) {
      addLog(msg, msg.startsWith('──') ? 'info' : 'info');
      return;
    }
    if (!state.files[index]) return;
    state.files[index].logs.push(msg);
    updateFileItem(index);
    addLog(`  ${msg}`);
  });

  window.vadCut.on('process:fileStage', ({ index, stage, pct }) => {
    if (!state.files[index]) return;
    state.files[index].stageLabel = stageLabel(stage);
    state.files[index].stagePct = pct;
    updateFileItem(index);
    updateOverallProgress();
  });

  window.vadCut.on('process:fileDone', ({ index, result }) => {
    if (!state.files[index]) return;
    state.files[index].result = result;
    if (result.skipped) {
      state.files[index].status = 'skip';
      addLog(`  → 已跳过`, 'warn');
    } else if (result.copied) {
      state.files[index].status = 'copy';
      addLog(`  → 直接复制（无需剪辑）`, 'warn');
    } else {
      state.files[index].status = 'done';
      addLog(`  → 完成 ✓ 切头 ${result.headCut.toFixed(1)}s，切尾 ${result.tailCut.toFixed(1)}s`, 'success');
    }
    updateFileItem(index);
    updateOverallProgress();
  });

  window.vadCut.on('process:fileError', ({ index, errMsg }) => {
    if (!state.files[index]) return;
    state.files[index].status = 'error';
    state.files[index].errorMsg = errMsg;
    updateFileItem(index);
    updateOverallProgress();
    addLog(`  [错误] ${errMsg}`, 'error');
  });

  window.vadCut.on('process:allDone', (summary) => {
    state.running = false;
    hide(btnCancel);
    show(btnStart);
    btnStart.disabled = false;

    if (summary.error) {
      addLog(`处理异常: ${summary.error}`, 'error');
      progressLabel.textContent = '处理出错';
      return;
    }

    state.outputDir = summary.outputDir;
    progressBar.style.width = '100%';

    const msg = summary.total === 0
      ? '未找到视频文件'
      : `处理完成：成功 ${summary.success}，跳过 ${summary.skipped}，出错 ${summary.errors}`;
    progressLabel.textContent = msg;
    addLog(msg, summary.errors > 0 ? 'warn' : 'success');

    if (summary.totalElapsed) {
      addLog(`总耗时: ${formatElapsed(summary.totalElapsed)}`, 'info');
    }

    if (summary.outputDir) {
      show(btnOpenOutput);
      addLog(`输出目录: ${summary.outputDir}`, 'info');
    }
  });
}

// ── Event Handlers ─────────────────────────────────────────────────────────

// 拖拽进入
dropzone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', (e) => {
  if (!dropzone.contains(e.relatedTarget)) {
    dropzone.classList.remove('drag-over');
  }
});

// 拖拽放入
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');

  const items = e.dataTransfer.items;
  if (items && items.length > 0) {
    const entry = items[0].webkitGetAsEntry?.();
    if (entry && entry.isDirectory) {
      // webkitGetAsEntry 返回的 fullPath 不是系统路径，需要用 file API
      const file = e.dataTransfer.files[0];
      if (file && file.path) {
        setFolder(file.path);
        return;
      }
    }
  }

  // fallback: 直接读取 files[0].path
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const f = files[0];
    // Electron 中 File 对象有 .path 属性
    if (f.path) {
      // 判断是否为文件夹：Electron 拖拽文件夹时 size === 0
      // 更可靠方式是检查扩展名是否为空
      const p = f.path;
      setFolder(p);
    }
  }
});

// 点击选择
dropzone.addEventListener('click', async () => {
  const folderPath = await window.vadCut.openFolder();
  if (folderPath) setFolder(folderPath);
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') dropzone.click();
});

// 更换文件夹
btnChange.addEventListener('click', async () => {
  if (state.running) return;
  hide(toolbar, overallProgress, fileListSection, logSection);
  show(dropzone);
  state.folderPath = null;
});

// 开始
btnStart.addEventListener('click', () => startProcessing());

// 取消
btnCancel.addEventListener('click', async () => {
  await window.vadCut.cancelProcess();
  addLog('用户取消处理', 'warn');
  btnCancel.disabled = true;
});

// 打开输出目录
btnOpenOutput.addEventListener('click', () => {
  if (state.outputDir) window.vadCut.shellOpenFolder(state.outputDir);
});

// 清空日志
btnClearLog.addEventListener('click', () => { logPanel.innerHTML = ''; });

// 处理拖拽文件夹启动（从bat传入的文件夹参数）
window.vadCut.on('init:folder', (folderPath) => {
  if (folderPath) setFolder(folderPath);
});
