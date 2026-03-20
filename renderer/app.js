'use strict';

// ── Theme ───────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('vadcut-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vadcut-theme', theme);
  const iconDark = document.getElementById('icon-theme-dark');
  const iconLight = document.getElementById('icon-theme-light');
  if (iconDark && iconLight) {
    iconDark.style.display = theme === 'dark' ? '' : 'none';
    iconLight.style.display = theme === 'light' ? '' : 'none';
  }
}

function formatElapsed(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}秒`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}分${s}秒`;
}

const $ = (sel) => document.querySelector(sel);

const panels = {
  clip: {
    tabButton: $('[data-tab="clip"]'),
    panel: $('#panel-clip'),
    dropzone: $('#dropzone'),
    toolbar: $('#toolbar'),
    folderPathEl: $('#folder-path'),
    btnChange: $('#btn-change'),
    btnStart: $('#btn-start'),
    btnCancel: $('#btn-cancel'),
    btnOpenOutput: $('#btn-open-output'),
    overallProgress: $('#overall-progress'),
    progressLabel: $('#progress-label'),
    progressCount: $('#progress-count'),
    progressBar: $('#progress-bar'),
    fileListSection: $('#file-list-section'),
    fileList: $('#file-list'),
    logSection: $('#log-section'),
    logPanel: $('#log-panel'),
    btnClearLog: $('#btn-clear-log'),
  },
  subtitle: {
    tabButton: $('[data-tab="subtitle"]'),
    panel: $('#panel-subtitle'),
    dropzone: $('#sub-dropzone'),
    toolbar: $('#sub-toolbar'),
    folderPathEl: $('#sub-folder-path'),
    btnChange: $('#sub-btn-change'),
    btnStart: $('#sub-btn-start'),
    btnCancel: $('#sub-btn-cancel'),
    btnOpenOutput: $('#sub-btn-open-output'),
    overallProgress: $('#sub-overall-progress'),
    progressLabel: $('#sub-progress-label'),
    progressCount: $('#sub-progress-count'),
    progressBar: $('#sub-progress-bar'),
    fileListSection: $('#sub-file-list-section'),
    fileList: $('#sub-file-list'),
    logSection: $('#sub-log-section'),
    logPanel: $('#sub-log-panel'),
    btnClearLog: $('#sub-btn-clear-log'),
  },
};

const states = {
  clip: { folderPath: null, files: [], running: false, outputDir: null },
  subtitle: { folderPath: null, files: [], running: false, outputDir: null },
};

let activeTab = 'clip';
let runningTab = null;

function show(...els) { els.forEach((e) => e.classList.remove('hidden')); }
function hide(...els) { els.forEach((e) => e.classList.add('hidden')); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addLog(tab, msg, type = 'info') {
  const refs = panels[tab];
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `[${ts}] ${msg}`;
  refs.logPanel.appendChild(line);
  refs.logPanel.scrollTop = refs.logPanel.scrollHeight;
}

function stageLabel(stage) {
  return {
    metadata: '读取元数据',
    audio: '提取音频',
    vad: 'VAD检测',
    trim: '剪辑视频',
    asr: '提取字幕',
  }[stage] || stage;
}

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
    default:
      return '';
  }
}

function badgeClass(status) {
  return {
    waiting: 'badge-waiting',
    running: 'badge-running',
    done: 'badge-done',
    skip: 'badge-skip',
    error: 'badge-error',
    copy: 'badge-copy',
  }[status] || 'badge-waiting';
}

function badgeText(file, tab) {
  switch (file.status) {
    case 'waiting':
      return '等待中';
    case 'running':
      return file.stageLabel || '处理中';
    case 'done':
      return tab === 'subtitle'
        ? '字幕已生成'
        : (file.result?.copied ? '已复制' : `切头${(file.result?.headCut || 0).toFixed(1)}s 切尾${(file.result?.tailCut || 0).toFixed(1)}s`);
    case 'skip':
      return '已跳过';
    case 'error':
      return '出错';
    case 'copy':
      return '直接复制';
    default:
      return '';
  }
}

function buildResultText(file, tab) {
  if (file.status === 'error') return file.errorMsg || '未知错误';
  if (file.status !== 'done' || file.result?.skipped) return '';
  if (tab === 'subtitle') {
    const srtName = file.result?.srtPath?.split(/[\\/]/).pop();
    return srtName ? `SRT 已生成 → ${srtName}` : 'SRT 字幕已生成';
  }
  if (file.result?.copied) return '直接复制（无需剪辑）';
  return `已剪辑 → 切掉开头 ${(file.result?.headCut || 0).toFixed(1)}s，结尾 ${(file.result?.tailCut || 0).toFixed(1)}s`;
}

function itemId(tab, index) {
  return `${tab}-file-item-${index}`;
}

function renderFileItem(file, index, tab) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.id = itemId(tab, index);
  el.innerHTML = buildFileItemHTML(file, tab);
  return el;
}

function buildFileItemHTML(file, tab) {
  const pct = file.stagePct ?? 0;
  const logText = file.logs.length ? file.logs[file.logs.length - 1] : '';
  const showBar = file.status === 'running';
  const resultText = buildResultText(file, tab);
  const resultClass = file.status === 'error' ? 'error' : '';

  return `
    <div class="file-item-header">
      ${statusIcon(file.status)}
      <span class="file-name" title="${escHtml(file.path)}">${escHtml(file.name)}</span>
      <span class="file-badge ${badgeClass(file.status)}">${escHtml(badgeText(file, tab))}</span>
    </div>
    ${showBar ? `
    <div class="file-stage-bar">
      <div class="file-stage-fill" style="width:${pct}%"></div>
    </div>` : ''}
    ${logText ? `<div class="file-log">${escHtml(logText)}</div>` : ''}
    ${resultText ? `<div class="file-result ${resultClass}">${escHtml(resultText)}</div>` : ''}
  `;
}

function updateFileItem(tab, index) {
  const el = document.getElementById(itemId(tab, index));
  if (el) el.innerHTML = buildFileItemHTML(states[tab].files[index], tab);
}

function updateOverallProgress(tab) {
  const state = states[tab];
  const refs = panels[tab];
  const total = state.files.length;
  const done = state.files.filter((f) => ['done', 'skip', 'error', 'copy'].includes(f.status)).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  refs.progressBar.style.width = pct + '%';
  refs.progressCount.textContent = `${done} / ${total}`;
  if (state.running) {
    const current = state.files.findIndex((f) => f.status === 'running');
    refs.progressLabel.textContent = current >= 0
      ? `正在处理: ${state.files[current].name}`
      : '处理中...';
  }
}

function switchTab(tab) {
  activeTab = tab;
  Object.entries(panels).forEach(([key, refs]) => {
    refs.tabButton.classList.toggle('active', key === tab);
    refs.panel.classList.toggle('hidden', key !== tab);
  });
}

function resetPanelToSelect(tab) {
  const state = states[tab];
  const refs = panels[tab];
  if (state.running) return;
  hide(refs.toolbar, refs.overallProgress, refs.fileListSection, refs.logSection);
  show(refs.dropzone);
  state.folderPath = null;
  state.files = [];
  state.outputDir = null;
}

function setFolder(tab, folderPath) {
  const state = states[tab];
  const refs = panels[tab];

  state.folderPath = folderPath;
  state.files = [];
  state.outputDir = null;

  refs.folderPathEl.textContent = folderPath;
  hide(refs.dropzone);
  show(refs.toolbar);
  hide(refs.overallProgress, refs.fileListSection, refs.logSection, refs.btnOpenOutput, refs.btnCancel);
  show(refs.btnStart);
  refs.btnStart.disabled = false;
  refs.btnCancel.disabled = false;

  refs.fileList.innerHTML = '';
  refs.logPanel.innerHTML = '';

  addLog(tab, `已选择文件夹: ${folderPath}`);
  show(refs.logSection);
}

function startProcessing(tab) {
  const state = states[tab];
  const refs = panels[tab];
  if (!state.folderPath || state.running || runningTab) return;

  state.running = true;
  state.files = [];
  state.outputDir = null;
  runningTab = tab;

  refs.fileList.innerHTML = '';
  refs.logPanel.innerHTML = '';
  refs.btnCancel.disabled = false;

  hide(refs.btnStart, refs.btnOpenOutput);
  show(refs.btnCancel, refs.overallProgress, refs.fileListSection, refs.logSection);
  refs.progressBar.style.width = '0%';
  refs.progressLabel.textContent = '扫描文件...';
  refs.progressCount.textContent = '';

  addLog(tab, tab === 'subtitle' ? '开始提取字幕...' : '开始剪辑...', 'info');
  registerIPCListeners(tab);
  window.vadCut.startProcess(state.folderPath, { subtitleOnly: tab === 'subtitle' });
}

function registerIPCListeners(tab) {
  const state = states[tab];
  const refs = panels[tab];

  ['process:scan', 'process:fileStart', 'process:fileLog',
    'process:fileStage', 'process:fileDone', 'process:fileError', 'process:allDone']
    .forEach((ch) => window.vadCut.removeAllListeners(ch));

  window.vadCut.on('process:scan', (files) => {
    if (files.length === 0) {
      addLog(tab, '未找到视频文件', 'warn');
      return;
    }

    addLog(tab, `找到 ${files.length} 个视频文件`, 'info');
    state.files = files.map((fp) => ({
      path: fp,
      name: fp.split(/[\\/]/).pop(),
      status: 'waiting',
      stageLabel: '',
      stagePct: 0,
      logs: [],
      result: null,
      errorMsg: null,
    }));

    refs.fileList.innerHTML = '';
    state.files.forEach((file, index) => {
      refs.fileList.appendChild(renderFileItem(file, index, tab));
    });
    show(refs.fileListSection);
    updateOverallProgress(tab);
  });

  window.vadCut.on('process:fileStart', ({ index }) => {
    if (!state.files[index]) return;
    state.files[index].status = 'running';
    state.files[index].stagePct = 0;
    updateFileItem(tab, index);
    updateOverallProgress(tab);
    addLog(tab, `▶ [${index + 1}] ${state.files[index].name}`);
    const el = document.getElementById(itemId(tab, index));
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  window.vadCut.on('process:fileLog', ({ index, msg }) => {
    if (index === -1) {
      addLog(tab, msg, 'info');
      return;
    }
    if (!state.files[index]) return;
    state.files[index].logs.push(msg);
    updateFileItem(tab, index);
    addLog(tab, `  ${msg}`);
  });

  window.vadCut.on('process:fileStage', ({ index, stage, pct }) => {
    if (!state.files[index]) return;
    state.files[index].stageLabel = stageLabel(stage);
    state.files[index].stagePct = pct;
    updateFileItem(tab, index);
    updateOverallProgress(tab);
  });

  window.vadCut.on('process:fileDone', ({ index, result }) => {
    if (!state.files[index]) return;
    state.files[index].result = result;

    if (result.skipped) {
      state.files[index].status = 'skip';
      addLog(tab, '  → 已跳过', 'warn');
    } else if (tab === 'subtitle') {
      state.files[index].status = 'done';
      addLog(tab, '  → 字幕已生成 ✓', 'success');
    } else if (result.copied) {
      state.files[index].status = 'copy';
      addLog(tab, '  → 直接复制（无需剪辑）', 'warn');
    } else {
      state.files[index].status = 'done';
      addLog(tab, `  → 完成 ✓ 切头 ${result.headCut.toFixed(1)}s，切尾 ${result.tailCut.toFixed(1)}s`, 'success');
    }

    updateFileItem(tab, index);
    updateOverallProgress(tab);
  });

  window.vadCut.on('process:fileError', ({ index, errMsg }) => {
    if (!state.files[index]) return;
    state.files[index].status = 'error';
    state.files[index].errorMsg = errMsg;
    updateFileItem(tab, index);
    updateOverallProgress(tab);
    addLog(tab, `  [错误] ${errMsg}`, 'error');
  });

  window.vadCut.on('process:allDone', (summary) => {
    state.running = false;
    runningTab = null;
    hide(refs.btnCancel);
    show(refs.btnStart);
    refs.btnStart.disabled = false;
    refs.btnCancel.disabled = false;

    if (summary.error) {
      addLog(tab, `处理异常: ${summary.error}`, 'error');
      refs.progressLabel.textContent = tab === 'subtitle' ? '提取出错' : '处理出错';
      return;
    }

    state.outputDir = summary.outputDir;
    refs.progressBar.style.width = '100%';

    const msg = summary.total === 0
      ? '未找到视频文件'
      : `${tab === 'subtitle' ? '提取完成' : '处理完成'}：成功 ${summary.success}，跳过 ${summary.skipped}，出错 ${summary.errors}`;
    refs.progressLabel.textContent = msg;
    addLog(tab, msg, summary.errors > 0 ? 'warn' : 'success');

    if (summary.totalElapsed) {
      addLog(tab, `总耗时: ${formatElapsed(summary.totalElapsed)}`, 'info');
    }

    if (summary.outputDir) {
      show(refs.btnOpenOutput);
      addLog(tab, `${tab === 'subtitle' ? '所在目录' : '输出目录'}: ${summary.outputDir}`, 'info');
    }
  });
}

function bindPanel(tab) {
  const state = states[tab];
  const refs = panels[tab];

  refs.dropzone.addEventListener('click', async () => {
    const folderPath = await window.vadCut.openFolder();
    if (folderPath) setFolder(tab, folderPath);
  });

  refs.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') refs.dropzone.click();
  });

  refs.btnChange.addEventListener('click', () => {
    if (state.running) return;
    resetPanelToSelect(tab);
  });

  refs.btnStart.addEventListener('click', () => startProcessing(tab));

  refs.btnCancel.addEventListener('click', async () => {
    if (runningTab !== tab) return;
    await window.vadCut.cancelProcess();
    addLog(tab, '用户取消处理', 'warn');
    refs.btnCancel.disabled = true;
  });

  refs.btnOpenOutput.addEventListener('click', () => {
    if (state.outputDir) window.vadCut.shellOpenFolder(state.outputDir);
  });

  refs.btnClearLog.addEventListener('click', () => {
    refs.logPanel.innerHTML = '';
  });
}

Object.keys(panels).forEach(bindPanel);
document.querySelectorAll('.tab-item').forEach((el) => {
  el.addEventListener('click', () => switchTab(el.dataset.tab));
});
switchTab(activeTab);

$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});
applyTheme(localStorage.getItem('vadcut-theme') || 'dark');

$('#btn-win-min').addEventListener('click', () => window.vadCut.windowMinimize());
$('#btn-win-max').addEventListener('click', () => window.vadCut.windowMaximize());
$('#btn-win-close').addEventListener('click', () => window.vadCut.windowClose());

const SVG_MAXIMIZE = `<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>`;
const SVG_RESTORE = `<rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/><rect x="0" y="2" width="8" height="8" fill="var(--bg-card)" stroke="currentColor" stroke-width="1"/>`;
window.vadCut.on('window:maximized', (isMax) => {
  const maxBtn = $('#btn-win-max');
  const svg = maxBtn?.querySelector('svg');
  if (svg) {
    svg.innerHTML = isMax ? SVG_RESTORE : SVG_MAXIMIZE;
  }
});
