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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)}${units[idx]}`;
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

const subtitleSchemeUi = {
  select: $('#sub-scheme-select'),
  modal: $('#scheme-modal'),
  modalTitle: $('#scheme-modal-title'),
  modalDesc: $('#scheme-modal-desc'),
  modalProgress: $('#scheme-modal-progress'),
  progressBar: $('#scheme-modal-progress-bar'),
  progressText: $('#scheme-modal-progress-text'),
  btnPrimary: $('#scheme-modal-primary'),
  btnSecondary: $('#scheme-modal-secondary'),
};

const subtitleSchemeState = {
  currentSchemeId: null,
  schemes: new Map(),
  modalSchemeId: null,
  modalAction: null,
  pendingAutoStartSchemeId: null,
};

let activeTab = 'clip';
let runningTab = null;
const MAX_LOG_LINES = 400;
const renderQueues = {
  clip: createRenderQueue(),
  subtitle: createRenderQueue(),
};

function createRenderQueue() {
  return {
    pending: false,
    pendingLogs: [],
    dirtyItems: new Set(),
    overallDirty: false,
  };
}

function resetRenderQueue(tab) {
  const queue = renderQueues[tab];
  queue.pendingLogs = [];
  queue.dirtyItems.clear();
  queue.overallDirty = false;
}

function scheduleRenderFlush(tab) {
  const queue = renderQueues[tab];
  if (queue.pending) return;
  queue.pending = true;
  requestAnimationFrame(() => {
    queue.pending = false;
    flushRenderQueue(tab);
  });
}

function createLogLine(msg, type) {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `[${ts}] ${msg}`;
  return line;
}

function trimLogPanel(panel) {
  while (panel.childElementCount > MAX_LOG_LINES) {
    panel.removeChild(panel.firstElementChild);
  }
}

function flushRenderQueue(tab) {
  const queue = renderQueues[tab];
  const refs = panels[tab];

  if (queue.pendingLogs.length > 0) {
    const fragment = document.createDocumentFragment();
    const logs = queue.pendingLogs.splice(0, queue.pendingLogs.length);
    logs.forEach(({ msg, type }) => fragment.appendChild(createLogLine(msg, type)));
    refs.logPanel.appendChild(fragment);
    trimLogPanel(refs.logPanel);
    refs.logPanel.scrollTop = refs.logPanel.scrollHeight;
  }

  if (queue.dirtyItems.size > 0) {
    const dirtyIndexes = Array.from(queue.dirtyItems).sort((a, b) => a - b);
    queue.dirtyItems.clear();
    dirtyIndexes.forEach((index) => syncFileItem(tab, index));
  }

  if (queue.overallDirty) {
    queue.overallDirty = false;
    syncOverallProgress(tab);
  }
}

function show(...els) {
  els.filter(Boolean).forEach((el) => el.classList.remove('hidden'));
}

function hide(...els) {
  els.filter(Boolean).forEach((el) => el.classList.add('hidden'));
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addLog(tab, msg, type = 'info') {
  renderQueues[tab].pendingLogs.push({ msg, type });
  scheduleRenderFlush(tab);
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
    const schemeLabel = file.result?.subtitleSchemeLabel ? ` · ${file.result.subtitleSchemeLabel}` : '';
    const srtName = file.result?.srtPath?.split(/[\\/]/).pop();
    return srtName
      ? `SRT 已生成${schemeLabel} → ${srtName}`
      : `SRT 字幕已生成${schemeLabel}`;
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

function syncFileItem(tab, index) {
  const el = document.getElementById(itemId(tab, index));
  if (el) {
    el.innerHTML = buildFileItemHTML(states[tab].files[index], tab);
  }
}

function updateFileItem(tab, index) {
  renderQueues[tab].dirtyItems.add(index);
  scheduleRenderFlush(tab);
}

function syncOverallProgress(tab) {
  const state = states[tab];
  const refs = panels[tab];
  const total = state.files.length;
  const done = state.files.filter((file) => ['done', 'skip', 'error', 'copy'].includes(file.status)).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  refs.progressBar.style.width = `${pct}%`;
  refs.progressCount.textContent = `${done} / ${total}`;
  if (state.running) {
    const current = state.files.findIndex((file) => file.status === 'running');
    refs.progressLabel.textContent = current >= 0
      ? `正在处理: ${state.files[current].name}`
      : '处理中...';
  }
}

function updateOverallProgress(tab) {
  renderQueues[tab].overallDirty = true;
  scheduleRenderFlush(tab);
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
  if (tab === 'subtitle') {
    syncSubtitleStartAvailability();
  }
}

function setFolder(tab, folderPath) {
  const state = states[tab];
  const refs = panels[tab];

  state.folderPath = folderPath;
  state.files = [];
  state.outputDir = null;
  resetRenderQueue(tab);

  refs.folderPathEl.textContent = folderPath;
  hide(refs.dropzone);
  show(refs.toolbar);
  hide(refs.overallProgress, refs.fileListSection, refs.logSection, refs.btnOpenOutput, refs.btnCancel);
  show(refs.btnStart);
  refs.btnCancel.disabled = false;

  refs.fileList.innerHTML = '';
  refs.logPanel.innerHTML = '';

  addLog(tab, `已选择文件夹: ${folderPath}`);
  show(refs.logSection);

  if (tab === 'subtitle') {
    syncSubtitleStartAvailability();
  } else {
    refs.btnStart.disabled = false;
  }
}

function getSelectedSubtitleScheme() {
  if (!subtitleSchemeState.currentSchemeId) return null;
  return subtitleSchemeState.schemes.get(subtitleSchemeState.currentSchemeId) || null;
}

function getSubtitleSchemeProgressText(scheme) {
  if (!scheme) return '等待下载';
  if (scheme.state === 'downloading') {
    const progress = scheme.download || {};
    const pct = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
    const filePart = progress.file ? `${progress.file} · ` : '';
    const bytesPart = progress.totalBytes > 0
      ? `${formatBytes(progress.downloadedBytes || 0)} / ${formatBytes(progress.totalBytes || 0)}`
      : `${formatBytes(progress.downloadedBytes || 0)}`;
    return `${filePart}${pct}% (${bytesPart})`;
  }
  if (scheme.ready) {
    return '当前方案已就绪';
  }
  if (scheme.state === 'failed') {
    return scheme.downloadFailure || '下载失败';
  }
  if (scheme.downloadMode === 'confirm') {
    return `等待确认下载（约 ${scheme.downloadSizeLabel || '4.27GB'}）`;
  }
  return '等待下载';
}

function renderSubtitleSchemeOptions() {
  const select = subtitleSchemeUi.select;
  if (!select) return;

  const schemes = Array.from(subtitleSchemeState.schemes.values());
  const currentValue = subtitleSchemeState.currentSchemeId;
  select.innerHTML = '';

  schemes.forEach((scheme) => {
    const option = document.createElement('option');
    option.value = scheme.schemeId;
    option.textContent = scheme.ready ? scheme.label : `${scheme.label}（需下载）`;
    select.appendChild(option);
  });

  if (currentValue) {
    select.value = currentValue;
  }
}

function syncSubtitleStartAvailability() {
  const refs = panels.subtitle;
  const scheme = getSelectedSubtitleScheme();
  const canStart = Boolean(
    states.subtitle.folderPath
    && !states.subtitle.running
    && !runningTab
    && scheme
  );
  refs.btnStart.disabled = !canStart;
}

function hideSubtitleSchemeModal({ clearPendingAutoStart = false } = {}) {
  subtitleSchemeState.modalSchemeId = null;
  subtitleSchemeState.modalAction = null;
  if (clearPendingAutoStart) {
    subtitleSchemeState.pendingAutoStartSchemeId = null;
  }
  hide(subtitleSchemeUi.modal);
}

function updateSubtitleSchemeControls() {
  const modalScheme = subtitleSchemeState.modalSchemeId
    ? subtitleSchemeState.schemes.get(subtitleSchemeState.modalSchemeId)
    : null;
  subtitleSchemeUi.select.disabled = Boolean(runningTab);
  syncSubtitleStartAvailability();
  if (modalScheme) {
    updateSubtitleSchemeModal(modalScheme);
  }
}

function updateSubtitleSchemeModal(scheme) {
  if (!scheme) return;

  let title = `下载 ${scheme.label}`;
  let desc = `开始提取字幕前需要先下载 ${scheme.label}。下载完成后会自动开始当前任务。`;
  let primaryText = '立即下载';
  let secondaryText = '取消';
  let action = 'download';
  let showProgress = false;

  if (scheme.state === 'downloading') {
    title = `${scheme.label} 下载中`;
    desc = subtitleSchemeState.pendingAutoStartSchemeId === scheme.schemeId
      ? '模型下载完成后会自动开始提取字幕。你也可以先关闭弹窗，下载会继续在后台进行。'
      : '当前模型正在下载中，下载完成后即可开始提取字幕。';
    primaryText = '取消下载';
    secondaryText = '后台继续';
    action = 'cancel-download';
    showProgress = true;
  } else if (scheme.state === 'failed') {
    title = `${scheme.label} 下载失败`;
    desc = scheme.downloadFailure || '模型下载失败，请重试。';
    primaryText = '重试下载';
    secondaryText = '关闭';
    action = 'retry-download';
  } else if (scheme.downloadMode === 'confirm') {
    title = `确认下载 ${scheme.label}`;
    desc = `${scheme.label} 模型体积约 ${scheme.downloadSizeLabel || '4.27GB'}。确认后才会开始下载；下载完成后自动开始提取字幕。`;
    primaryText = '确认下载';
    secondaryText = '取消';
    action = 'confirm-download';
  }

  subtitleSchemeState.modalSchemeId = scheme.schemeId;
  subtitleSchemeState.modalAction = action;

  subtitleSchemeUi.modalTitle.textContent = title;
  subtitleSchemeUi.modalDesc.textContent = desc;
  subtitleSchemeUi.btnPrimary.textContent = primaryText;
  subtitleSchemeUi.btnSecondary.textContent = secondaryText;

  subtitleSchemeUi.progressText.textContent = getSubtitleSchemeProgressText(scheme);
  subtitleSchemeUi.progressBar.style.width = `${scheme.ready ? 100 : Math.max(0, Math.min(100, Math.round(scheme.download?.percent || 0)))}%`;
  if (showProgress) {
    show(subtitleSchemeUi.modalProgress);
  } else {
    hide(subtitleSchemeUi.modalProgress);
  }

  show(subtitleSchemeUi.modal);
}

function showSubtitleSchemeModal(scheme, { autoStart = false } = {}) {
  if (!scheme) return;
  if (autoStart) {
    subtitleSchemeState.pendingAutoStartSchemeId = scheme.schemeId;
  }
  updateSubtitleSchemeModal(scheme);
}

async function refreshSubtitleSchemeStatuses() {
  try {
    const payload = await window.vadCut.getSubtitleSchemeStatuses();
    subtitleSchemeState.schemes.clear();
    for (const scheme of payload?.schemes || []) {
      subtitleSchemeState.schemes.set(scheme.schemeId, scheme);
    }

    const fallbackSchemeId = payload?.schemes?.[0]?.schemeId || null;
    subtitleSchemeState.currentSchemeId = payload?.currentSchemeId || fallbackSchemeId;

    renderSubtitleSchemeOptions();
    updateSubtitleSchemeControls();
  } catch (err) {
    addLog('subtitle', `字幕方案状态检查失败: ${err.message}`, 'error');
  }
}

async function requestSubtitleSchemeDownload(scheme, confirmed = false) {
  if (!scheme) return;

  try {
    const result = await window.vadCut.downloadSubtitleScheme(scheme.schemeId);
    if (result?.ok === false && result.error) {
      addLog('subtitle', result.error, 'error');
    } else if (result?.running) {
      addLog('subtitle', `${scheme.label} 正在下载中`, 'warn');
    }
  } catch (err) {
    addLog('subtitle', `启动下载失败: ${err.message}`, 'error');
  }
}

async function startProcessing(tab) {
  const state = states[tab];
  const refs = panels[tab];
  if (!state.folderPath || state.running || runningTab) return;

  const options = { subtitleOnly: tab === 'subtitle' };
  if (tab === 'subtitle') {
    const scheme = getSelectedSubtitleScheme();
    if (!scheme) {
      addLog('subtitle', '未找到当前字幕方案，请稍后重试。', 'error');
      return;
    }
    if (!scheme.ready || scheme.state === 'downloading') {
      showSubtitleSchemeModal(scheme, { autoStart: true });
      syncSubtitleStartAvailability();
      return;
    }
    options.subtitleScheme = scheme.schemeId;
  }

  state.running = true;
  state.files = [];
  state.outputDir = null;
  runningTab = tab;
  resetRenderQueue(tab);

  refs.fileList.innerHTML = '';
  refs.logPanel.innerHTML = '';
  refs.btnCancel.disabled = false;

  hide(refs.btnStart, refs.btnOpenOutput);
  show(refs.btnCancel, refs.overallProgress, refs.fileListSection, refs.logSection);
  refs.progressBar.style.width = '0%';
  refs.progressLabel.textContent = '扫描文件...';
  refs.progressCount.textContent = '';

  if (tab === 'subtitle') {
    const scheme = getSelectedSubtitleScheme();
    if (scheme) {
      addLog('subtitle', `字幕方案: ${scheme.label}`, 'info');
    }
  }
  addLog(tab, tab === 'subtitle' ? '开始提取字幕...' : '开始剪辑...', 'info');
  registerIPCListeners(tab);
  updateSubtitleSchemeControls();

  try {
    const result = await window.vadCut.startProcess(state.folderPath, options);
    if (result?.error) {
      state.running = false;
      state.files = [];
      runningTab = null;
      hide(refs.btnCancel, refs.overallProgress, refs.fileListSection);
      show(refs.btnStart, refs.logSection);
      refs.btnCancel.disabled = false;
      refs.progressBar.style.width = '0%';
      refs.progressCount.textContent = '';
      refs.progressLabel.textContent = '';
      addLog(tab, result.error, 'error');
      if (tab === 'subtitle') {
        syncSubtitleStartAvailability();
        updateSubtitleSchemeControls();
      } else {
        refs.btnStart.disabled = false;
      }
    }
  } catch (err) {
    state.running = false;
    state.files = [];
    runningTab = null;
    hide(refs.btnCancel, refs.overallProgress, refs.fileListSection);
    show(refs.btnStart, refs.logSection);
    refs.btnCancel.disabled = false;
    refs.progressBar.style.width = '0%';
    refs.progressCount.textContent = '';
    refs.progressLabel.textContent = '';
    addLog(tab, `启动失败: ${err.message}`, 'error');
    if (tab === 'subtitle') {
      syncSubtitleStartAvailability();
      updateSubtitleSchemeControls();
    } else {
      refs.btnStart.disabled = false;
    }
  }
}

function registerIPCListeners(tab) {
  const state = states[tab];
  const refs = panels[tab];

  ['process:scan', 'process:fileStart', 'process:fileLog',
    'process:fileStage', 'process:fileDone', 'process:fileError', 'process:allDone']
    .forEach((channel) => window.vadCut.removeAllListeners(channel));

  window.vadCut.on('process:scan', (files) => {
    if (files.length === 0) {
      addLog(tab, '未找到视频文件', 'warn');
      return;
    }

    addLog(tab, `找到 ${files.length} 个视频文件`, 'info');
    state.files = files.map((filePath) => ({
      path: filePath,
      name: filePath.split(/[\\/]/).pop(),
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
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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
      const schemeSuffix = result.subtitleSchemeLabel ? ` (${result.subtitleSchemeLabel})` : '';
      addLog(tab, `  → 字幕已生成 ✓${schemeSuffix}`, 'success');
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
    refs.btnCancel.disabled = false;

    if (summary.error) {
      addLog(tab, `处理异常: ${summary.error}`, 'error');
      refs.progressLabel.textContent = tab === 'subtitle' ? '提取出错' : '处理出错';
      if (tab === 'subtitle') {
        syncSubtitleStartAvailability();
        updateSubtitleSchemeControls();
      } else {
        refs.btnStart.disabled = false;
      }
      return;
    }

    state.outputDir = summary.outputDir;
    refs.progressBar.style.width = '100%';

    const schemeSuffix = tab === 'subtitle' && summary.subtitleSchemeLabel
      ? `（${summary.subtitleSchemeLabel}）`
      : '';
    const msg = summary.total === 0
      ? '未找到视频文件'
      : `${tab === 'subtitle' ? `提取完成${schemeSuffix}` : '处理完成'}：成功 ${summary.success}，跳过 ${summary.skipped}，出错 ${summary.errors}`;
    refs.progressLabel.textContent = msg;
    addLog(tab, msg, summary.errors > 0 ? 'warn' : 'success');

    if (summary.totalElapsed) {
      addLog(tab, `总耗时: ${formatElapsed(summary.totalElapsed)}`, 'info');
    }

    if (summary.outputDir) {
      show(refs.btnOpenOutput);
      addLog(tab, `${tab === 'subtitle' ? '所在目录' : '输出目录'}: ${summary.outputDir}`, 'info');
    }

    if (tab === 'subtitle') {
      syncSubtitleStartAvailability();
      updateSubtitleSchemeControls();
    } else {
      refs.btnStart.disabled = false;
    }
  });
}

function bindPanel(tab) {
  const state = states[tab];
  const refs = panels[tab];

  refs.dropzone.addEventListener('click', async () => {
    const folderPath = await window.vadCut.openFolder();
    if (folderPath) {
      setFolder(tab, folderPath);
    }
  });

  refs.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      refs.dropzone.click();
    }
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
    if (state.outputDir) {
      window.vadCut.shellOpenFolder(state.outputDir);
    }
  });

  refs.btnClearLog.addEventListener('click', () => {
    resetRenderQueue(tab);
    refs.logPanel.innerHTML = '';
  });
}

function bindSubtitleSchemeControls() {
  subtitleSchemeUi.select?.addEventListener('change', async () => {
    const schemeId = subtitleSchemeUi.select.value;
    try {
      await window.vadCut.setCurrentSubtitleScheme(schemeId);
      subtitleSchemeState.currentSchemeId = schemeId;
      if (subtitleSchemeState.pendingAutoStartSchemeId && subtitleSchemeState.pendingAutoStartSchemeId !== schemeId) {
        subtitleSchemeState.pendingAutoStartSchemeId = null;
      }
      await refreshSubtitleSchemeStatuses();
      const scheme = getSelectedSubtitleScheme();
      if (scheme) {
        addLog('subtitle', `字幕方案已切换为: ${scheme.label}`, 'info');
      }
    } catch (err) {
      addLog('subtitle', `切换字幕方案失败: ${err.message}`, 'error');
    }
  });

  subtitleSchemeUi.btnPrimary?.addEventListener('click', async () => {
    const scheme = subtitleSchemeState.schemes.get(subtitleSchemeState.modalSchemeId || '')
      || getSelectedSubtitleScheme();
    if (!scheme) return;

    if (subtitleSchemeState.modalAction === 'cancel-download') {
      subtitleSchemeState.pendingAutoStartSchemeId = null;
      try {
        await window.vadCut.cancelSubtitleSchemeDownload(scheme.schemeId);
      } catch (err) {
        addLog('subtitle', `取消下载失败: ${err.message}`, 'error');
      }
      return;
    }

    await requestSubtitleSchemeDownload(scheme, true);
  });

  subtitleSchemeUi.btnSecondary?.addEventListener('click', () => {
    const clearPendingAutoStart = subtitleSchemeState.modalAction !== 'cancel-download';
    hideSubtitleSchemeModal({ clearPendingAutoStart });
  });
}

Object.keys(panels).forEach(bindPanel);
bindSubtitleSchemeControls();

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

window.vadCut.on('subtitleSchemes:downloadProgress', (progress) => {
  const scheme = subtitleSchemeState.schemes.get(progress.schemeId);
  if (!scheme) return;
  scheme.state = 'downloading';
  scheme.download = {
    ...(scheme.download || {}),
    downloading: true,
    file: progress.file || '',
    percent: Number(progress.percent || 0),
    downloadedBytes: Number(progress.downloadedBytes || 0),
    totalBytes: Number(progress.totalBytes || 0),
  };
  updateSubtitleSchemeControls();
});

window.vadCut.on('subtitleSchemes:downloadState', async (payload) => {
  const scheme = subtitleSchemeState.schemes.get(payload?.schemeId || '');
  if (scheme && (payload?.state === 'starting' || payload?.state === 'downloading')) {
    scheme.state = 'downloading';
    scheme.download = {
      ...(scheme.download || {}),
      downloading: true,
      percent: Number(scheme.download?.percent || 0),
      downloadedBytes: Number(scheme.download?.downloadedBytes || 0),
      totalBytes: Number(scheme.download?.totalBytes || 0),
      file: scheme.download?.file || '',
    };
    if (subtitleSchemeState.pendingAutoStartSchemeId === scheme.schemeId || subtitleSchemeState.modalSchemeId === scheme.schemeId) {
      showSubtitleSchemeModal(scheme);
    } else {
      updateSubtitleSchemeControls();
    }
  }

  if (payload?.message) {
    const logType = payload.state === 'failed'
      ? 'error'
      : (payload.state === 'cancelled' ? 'warn' : 'info');
    if (payload.state !== 'downloading' || payload.message.includes('完成') || payload.message.includes('已存在')) {
      addLog('subtitle', payload.message, logType);
    }
  }

  if (payload?.state === 'completed') {
    await refreshSubtitleSchemeStatuses();
    if (
      subtitleSchemeState.pendingAutoStartSchemeId === payload.schemeId
      && states.subtitle.folderPath
      && !states.subtitle.running
      && !runningTab
      && getSelectedSubtitleScheme()?.schemeId === payload.schemeId
      && getSelectedSubtitleScheme()?.ready
    ) {
      hideSubtitleSchemeModal();
      subtitleSchemeState.pendingAutoStartSchemeId = null;
      startProcessing('subtitle');
      return;
    }
    if (subtitleSchemeState.pendingAutoStartSchemeId === payload.schemeId) {
      subtitleSchemeState.pendingAutoStartSchemeId = null;
    }
    hideSubtitleSchemeModal();
    return;
  }

  if (payload?.state === 'cancelled' || payload?.state === 'failed') {
    await refreshSubtitleSchemeStatuses();
    const refreshedScheme = getSelectedSubtitleScheme();
    if (
      refreshedScheme
      && refreshedScheme.schemeId === payload.schemeId
      && (
        subtitleSchemeState.modalSchemeId === payload.schemeId
        || subtitleSchemeState.pendingAutoStartSchemeId === payload.schemeId
      )
    ) {
      showSubtitleSchemeModal(refreshedScheme);
    }
    return;
  }
});

refreshSubtitleSchemeStatuses();
