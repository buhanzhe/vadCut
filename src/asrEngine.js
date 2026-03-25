'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  getHomeDir,
  getUserDataPath,
  isPackagedRuntime,
  resolveBundledModelsRoot,
} = require('./runtimePaths');

const DOWNLOAD_CANCELLED_CODE = 'SUBTITLE_SCHEME_DOWNLOAD_CANCELLED';
const APP_HOME_DIR_NAME = '.vadCut';
const MODEL_ROOT_DIR_NAME = 'model';
const SETTINGS_DIR_NAME = 'settings';
const SUBTITLE_SCHEME_SELECTION_FILE = 'subtitle-scheme.json';
const DEFAULT_SUBTITLE_SCHEME_ID = 'paraformer-bilingual';
const MODELSCOPE_BASE_URL = 'https://www.modelscope.cn';
const MODELSCOPE_API_BASE_URL = 'https://modelscope.cn/api/v1/models';
const MODELSCOPE_REVISION = 'master';
const DEFAULT_HF_BASE_URL = 'https://hf-mirror.com';
const FALLBACK_HF_BASE_URL = 'https://huggingface.co';
const HF_REVISION = 'main';

const MODEL_DOWNLOAD_SOURCES = [
  {
    sourceId: 'streaming-zipformer-bilingual',
    label: 'Streaming Zipformer（中英双语）',
    sourceUrl: 'https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en',
    repoId: 'pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en',
    modelDir: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en',
    requiredFiles: [
      { key: 'encoder', path: 'encoder-epoch-99-avg-1.int8.onnx', required: true },
      { key: 'decoder', path: 'decoder-epoch-99-avg-1.onnx', required: true },
      { key: 'joiner', path: 'joiner-epoch-99-avg-1.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
      { key: 'configuration', path: 'configuration.json', required: false },
    ],
  },
  {
    sourceId: 'sense-voice-full',
    label: 'SenseVoice（全量）',
    sourceUrl: 'https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/files',
    repoId: 'pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue',
    modelDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue',
    requiredFiles: [
      { key: 'model', path: 'model.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
      { key: 'configuration', path: 'configuration.json', required: false },
    ],
  },
  {
    sourceId: 'paraformer-zh',
    label: 'Paraformer（中文，CPU/GPU）',
    sourceUrl: 'https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-paraformer-zh',
    repoId: 'pengzhendong/sherpa-onnx-paraformer-zh',
    modelDir: 'sherpa-onnx-paraformer-zh',
    requiredFiles: [
      { key: 'modelInt8', path: 'model.int8.onnx', required: true, expectedSize: 227330205 },
      { key: 'model', path: 'model.onnx', required: true, expectedSize: 822641426 },
      { key: 'tokens', path: 'tokens.txt', required: true, expectedSize: 75354 },
      { key: 'configuration', path: 'configuration.json', required: false, expectedSize: 56 },
    ],
  },
  {
    sourceId: 'offline-paraformer-zh',
    label: 'Offline Paraformer（中文）',
    sourceUrl: 'https://www.modelscope.cn/models/pengzhendong/offline-paraformer-zh/files',
    repoId: 'pengzhendong/offline-paraformer-zh',
    modelDir: 'offline-paraformer-zh',
    requiredFiles: [
      { key: 'modelInt8', path: 'model.int8.onnx', required: true },
      { key: 'model', path: 'model.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
      { key: 'configuration', path: 'configuration.json', required: false },
    ],
  },
  {
    sourceId: 'sense-voice-int8-2025-09-09',
    label: 'SenseVoice Int8（2025-09-09）',
    sourceUrl: 'https://www.modelscope.cn/models/Mr7Cat/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/files',
    repoId: 'Mr7Cat/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    modelDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    requiredFiles: [
      { key: 'model', path: 'model.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
      { key: 'configuration', path: 'configuration.json', required: false },
    ],
  },
  {
    sourceId: 'streaming-paraformer-bilingual',
    label: 'Streaming Paraformer（中英双语）',
    sourceUrl: 'https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/files',
    repoId: 'pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    modelDir: 'sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    requiredFiles: [
      { key: 'encoder', path: 'encoder.int8.onnx', required: true },
      { key: 'decoder', path: 'decoder.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
      { key: 'configuration', path: 'configuration.json', required: false },
    ],
  },
];

const MODEL_DOWNLOAD_SOURCE_MAP = new Map(
  MODEL_DOWNLOAD_SOURCES.map((source) => [source.sourceId, source])
);

const SUBTITLE_SCHEMES = [
  {
    schemeId: 'paraformer-bilingual',
    label: 'Paraformer（中英流式）',
    description: '默认方案，下载体积更小，基于 simulated streaming 逐句生成 SRT。',
    runtimeType: 'online',
    recognizerType: 'paraformer',
    decodePadStartSec: 0.18,
    decodePadEndSec: 0.36,
    decodeTailPaddingSec: 0.84,
    headRescueSec: 0.16,
    tailRescueSec: 0.36,
    sourceId: 'streaming-paraformer-bilingual',
    downloadMode: 'normal',
    modelDir: 'sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    requiredFiles: [
      { key: 'encoder', path: 'encoder.int8.onnx', required: true },
      { key: 'decoder', path: 'decoder.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
    ],
  },
  {
    schemeId: 'zipformer-bilingual',
    label: 'Zipformer（中英双语）',
    description: '流式 transducer 方案，适合补充双语字幕提取。',
    runtimeType: 'online',
    recognizerType: 'transducer',
    decodePadStartSec: 0.14,
    decodePadEndSec: 0.30,
    decodeTailPaddingSec: 0.72,
    headRescueSec: 0.12,
    tailRescueSec: 0.28,
    sourceId: 'streaming-zipformer-bilingual',
    downloadMode: 'normal',
    modelDir: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en',
    requiredFiles: [
      { key: 'encoder', path: 'encoder-epoch-99-avg-1.int8.onnx', required: true },
      { key: 'decoder', path: 'decoder-epoch-99-avg-1.onnx', required: true },
      { key: 'joiner', path: 'joiner-epoch-99-avg-1.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
    ],
  },
  {
    schemeId: 'sense-voice',
    label: 'SenseVoice（多语种）',
    description: '离线多语种字幕方案，适合中文、英文、粤语等混合内容。',
    runtimeType: 'offline',
    recognizerType: 'senseVoice',
    sourceId: 'sense-voice-full',
    downloadMode: 'normal',
    modelDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue',
    requiredFiles: [
      { key: 'model', path: 'model.int8.onnx', required: true },
      { key: 'tokens', path: 'tokens.txt', required: true },
    ],
  },
  {
    schemeId: 'offline-paraformer-zh',
    label: 'Offline Paraformer（中文）',
    description: '离线 Paraformer 方案。集成 sherpa-onnx-paraformer-zh；GPU 使用 model.onnx，CPU 使用 model.int8.onnx。',
    runtimeType: 'offline',
    recognizerType: 'offlineParaformer',
    sourceId: 'paraformer-zh',
    downloadMode: 'normal',
    modelDir: 'offline-paraformer-zh',
    providerPreference: ['directml', 'cpu'],
    requiredFiles: [
      { key: 'modelInt8', path: 'model.int8.onnx', required: true, expectedSize: 227330205 },
      { key: 'model', path: 'model.onnx', required: true, expectedSize: 822641426 },
      { key: 'tokens', path: 'tokens.txt', required: true, expectedSize: 75354 },
      { key: 'configuration', path: 'configuration.json', required: false, expectedSize: 56 },
    ],
  },
];

const SUBTITLE_SCHEME_MAP = new Map(
  SUBTITLE_SCHEMES.map((scheme) => [scheme.schemeId, scheme])
);

const schemeFailures = new Map();
const schemeDownloads = new Map();

function getProjectModelsRoot() {
  return path.join(__dirname, '..', 'models');
}

function getWritableModelsRoot() {
  return path.join(getHomeDir(), APP_HOME_DIR_NAME, MODEL_ROOT_DIR_NAME);
}

function getBundledModelsRoot() {
  return isPackagedRuntime()
    ? resolveBundledModelsRoot(__dirname)
    : getProjectModelsRoot();
}

function getSettingsRoot() {
  const userDataPath = getUserDataPath();
  if (userDataPath) {
    return path.join(userDataPath, SETTINGS_DIR_NAME);
  }
  return path.join(getHomeDir(), APP_HOME_DIR_NAME, SETTINGS_DIR_NAME);
}

function getSubtitleSchemeSelectionPath() {
  return path.join(getSettingsRoot(), SUBTITLE_SCHEME_SELECTION_FILE);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getModelDownloadSource(sourceId) {
  return MODEL_DOWNLOAD_SOURCE_MAP.get(sourceId) || null;
}

function cloneSchemeInfo(scheme) {
  const downloadSource = scheme.sourceId ? getModelDownloadSource(scheme.sourceId) : null;
  return {
    schemeId: scheme.schemeId,
    label: scheme.label,
    description: scheme.description,
    runtimeType: scheme.runtimeType,
    recognizerType: scheme.recognizerType || null,
    providerPreference: Array.isArray(scheme.providerPreference)
      ? [...scheme.providerPreference]
      : null,
    sourceId: scheme.sourceId || null,
    sourceUrl: downloadSource?.sourceUrl || scheme.sourceUrl || null,
    downloadMode: scheme.downloadMode,
    downloadSizeLabel: scheme.downloadSizeLabel || null,
    decodePadStartSec: Number.isFinite(scheme.decodePadStartSec) ? scheme.decodePadStartSec : null,
    decodePadEndSec: Number.isFinite(scheme.decodePadEndSec) ? scheme.decodePadEndSec : null,
    decodeTailPaddingSec: Number.isFinite(scheme.decodeTailPaddingSec) ? scheme.decodeTailPaddingSec : null,
    headRescueSec: Number.isFinite(scheme.headRescueSec) ? scheme.headRescueSec : null,
    tailRescueSec: Number.isFinite(scheme.tailRescueSec) ? scheme.tailRescueSec : null,
    modelDir: scheme.modelDir,
    requiredFiles: scheme.requiredFiles.map((file) => ({ ...file })),
  };
}

function resolveSubtitleSchemeId(schemeId) {
  if (schemeId && SUBTITLE_SCHEME_MAP.has(schemeId)) {
    return schemeId;
  }
  return DEFAULT_SUBTITLE_SCHEME_ID;
}

function getSubtitleSchemeDefinition(schemeId) {
  return SUBTITLE_SCHEME_MAP.get(resolveSubtitleSchemeId(schemeId));
}

function resolveSubtitleSchemeInfo(schemeId) {
  return cloneSchemeInfo(getSubtitleSchemeDefinition(schemeId));
}

function getSubtitleSchemes() {
  return SUBTITLE_SCHEMES.map((scheme) => cloneSchemeInfo(scheme));
}

function getWritableSchemeDir(schemeId) {
  const scheme = getSubtitleSchemeDefinition(schemeId);
  return path.join(getWritableModelsRoot(), scheme.modelDir);
}

function getBundledSchemeDir(schemeId) {
  const scheme = getSubtitleSchemeDefinition(schemeId);
  return path.join(getBundledModelsRoot(), scheme.modelDir);
}

function fileMatches(filePath, expectedSize = 0) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (expectedSize > 0 && stat.size !== expectedSize) return false;
    return stat.size > 0;
  } catch {
    return false;
  }
}

function getMissingFilesForSchemeDir(dirPath, scheme) {
  return scheme.requiredFiles
    .filter((file) => file.required && !fileMatches(path.join(dirPath, file.path), file.expectedSize || 0))
    .map((file) => file.path);
}

function encodeRepoPath(filePath) {
  return encodeURIComponent(filePath);
}

function getHuggingFaceBaseUrls() {
  const envBaseUrl = String(process.env.VADCUT_HF_BASE_URL || '').trim();
  return Array.from(new Set([
    envBaseUrl || DEFAULT_HF_BASE_URL,
    FALLBACK_HF_BASE_URL,
  ].filter(Boolean)));
}

function buildFileDownloadUrls(scheme, filePath) {
  const downloadSource = scheme.sourceId ? getModelDownloadSource(scheme.sourceId) : null;
  if (downloadSource?.repoId) {
    return [
      `${MODELSCOPE_API_BASE_URL}/${downloadSource.repoId}/repo?Revision=${MODELSCOPE_REVISION}&FilePath=${encodeRepoPath(filePath)}`,
    ];
  }

  if (scheme.downloadProvider === 'huggingface' && scheme.repoId) {
    return getHuggingFaceBaseUrls().map((baseUrl) => (
      `${baseUrl.replace(/\/+$/, '')}/${scheme.repoId}/resolve/${HF_REVISION}/${filePath.split('/').map((part) => encodeURIComponent(part)).join('/')}`
    ));
  }

  return [];
}

function clearSchemeFailure(schemeId) {
  schemeFailures.delete(resolveSubtitleSchemeId(schemeId));
}

function setSchemeFailure(schemeId, message) {
  const resolvedSchemeId = resolveSubtitleSchemeId(schemeId);
  if (message) {
    schemeFailures.set(resolvedSchemeId, String(message));
  } else {
    clearSchemeFailure(resolvedSchemeId);
  }
}

function setSchemeDownloadState(schemeId, partialState) {
  const resolvedSchemeId = resolveSubtitleSchemeId(schemeId);
  const prev = schemeDownloads.get(resolvedSchemeId) || {};
  schemeDownloads.set(resolvedSchemeId, {
    ...prev,
    ...partialState,
  });
}

function clearSchemeDownloadState(schemeId) {
  schemeDownloads.delete(resolveSubtitleSchemeId(schemeId));
}

function toStatusState({ ready, downloading, failed }) {
  if (downloading) return 'downloading';
  if (ready) return 'ready';
  if (failed) return 'failed';
  return 'missing';
}

function getSubtitleSchemeStatus(schemeId) {
  const scheme = getSubtitleSchemeDefinition(schemeId);
  const resolvedSchemeId = scheme.schemeId;
  const writableDir = getWritableSchemeDir(resolvedSchemeId);
  const bundledDir = getBundledSchemeDir(resolvedSchemeId);

  const missingInWritable = getMissingFilesForSchemeDir(writableDir, scheme);
  let ready = false;
  let source = 'missing';
  let engineDir = writableDir;
  let missingFiles = missingInWritable;

  if (missingInWritable.length === 0) {
    ready = true;
    source = 'userHome';
  } else if (bundledDir !== writableDir) {
    const missingInBundled = getMissingFilesForSchemeDir(bundledDir, scheme);
    if (missingInBundled.length === 0) {
      ready = true;
      source = 'bundled';
      engineDir = bundledDir;
      missingFiles = [];
    }
  }

  if (ready) {
    clearSchemeFailure(resolvedSchemeId);
  }

  const download = schemeDownloads.get(resolvedSchemeId) || null;
  const failureMessage = ready ? null : (schemeFailures.get(resolvedSchemeId) || null);
  const failed = !!failureMessage;

  return {
    ...cloneSchemeInfo(scheme),
    ready,
    state: toStatusState({
      ready,
      downloading: !!download?.downloading,
      failed,
    }),
    source,
    engineDir,
    missingFiles,
    writableDir,
    bundledDir,
    download: download ? { ...download } : null,
    downloadFailure: failureMessage,
  };
}

function getAllSubtitleSchemeStatuses() {
  return {
    currentSchemeId: getCurrentSubtitleScheme(),
    schemes: SUBTITLE_SCHEMES.map((scheme) => getSubtitleSchemeStatus(scheme.schemeId)),
  };
}

function getCurrentSubtitleScheme() {
  try {
    const filePath = getSubtitleSchemeSelectionPath();
    if (!fs.existsSync(filePath)) {
      return DEFAULT_SUBTITLE_SCHEME_ID;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return resolveSubtitleSchemeId(parsed?.schemeId);
  } catch {
    return DEFAULT_SUBTITLE_SCHEME_ID;
  }
}

function setCurrentSubtitleScheme(schemeId) {
  const resolvedSchemeId = resolveSubtitleSchemeId(schemeId);
  ensureDir(getSettingsRoot());
  fs.writeFileSync(
    getSubtitleSchemeSelectionPath(),
    JSON.stringify({ schemeId: resolvedSchemeId }, null, 2),
    'utf8'
  );
  return resolveSubtitleSchemeInfo(resolvedSchemeId);
}

function getSubtitleSchemeAssets(schemeId) {
  const scheme = getSubtitleSchemeDefinition(schemeId);
  const status = getSubtitleSchemeStatus(scheme.schemeId);

  if (!status.ready) {
    const missingLabel = status.missingFiles.length > 0
      ? `缺少文件: ${status.missingFiles.join(', ')}`
      : '未检测到可用模型文件';
    return {
      ready: false,
      scheme: cloneSchemeInfo(scheme),
      status,
      reason: `${scheme.label} 未就绪，${missingLabel}`,
    };
  }

  const files = {};
  for (const file of scheme.requiredFiles) {
    files[file.key] = path.join(status.engineDir, file.path);
  }

  return {
    ready: true,
    scheme: cloneSchemeInfo(scheme),
    status,
    engineDir: status.engineDir,
    files,
  };
}

function buildFileStatusMessage(scheme, filePath, prefix) {
  return `${scheme.label} ${prefix}: ${filePath}`;
}

function getExpectedFileSize(file) {
  const expectedSize = Number(file?.expectedSize || 0);
  return Number.isFinite(expectedSize) && expectedSize > 0 ? expectedSize : 0;
}

function createDownloadProgressTracker(requiredFiles = []) {
  const files = Array.isArray(requiredFiles) ? requiredFiles : [];
  const observedUnknownFileTotals = new Map();
  const knownExpectedTotalBytes = files.reduce(
    (sum, file) => sum + getExpectedFileSize(file),
    0
  );

  function observeFileTotal(file, bytes) {
    if (!file || getExpectedFileSize(file) > 0) {
      return;
    }

    const normalizedBytes = Math.round(Number(bytes) || 0);
    if (normalizedBytes <= 0) {
      return;
    }

    const prevBytes = observedUnknownFileTotals.get(file) || 0;
    if (normalizedBytes > prevBytes) {
      observedUnknownFileTotals.set(file, normalizedBytes);
    }
  }

  function getTotalBytes() {
    let observedUnknownTotalBytes = 0;
    for (const bytes of observedUnknownFileTotals.values()) {
      observedUnknownTotalBytes += bytes;
    }
    return knownExpectedTotalBytes + observedUnknownTotalBytes;
  }

  function getProgress(downloadedBytes) {
    const safeDownloadedBytes = Math.max(0, Math.round(Number(downloadedBytes) || 0));
    const totalBytes = Math.max(getTotalBytes(), safeDownloadedBytes);
    return {
      downloadedBytes: safeDownloadedBytes,
      totalBytes,
      percent: totalBytes > 0
        ? Math.min(100, Math.round((safeDownloadedBytes / totalBytes) * 100))
        : 0,
    };
  }

  return {
    observeFileTotal,
    getProgress,
  };
}

function createCancelledError() {
  const err = new Error('下载已取消');
  err.code = DOWNLOAD_CANCELLED_CODE;
  return err;
}

function downloadFromUrl(url, targetPath, signal, onProgress, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error('下载失败：重定向次数过多'));
  }

  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const req = https.get({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: '*/*',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const location = res.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        res.resume();
        const nextUrl = new URL(location, url).toString();
        downloadFromUrl(nextUrl, targetPath, signal, onProgress, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          reject(new Error(`下载失败（HTTP ${statusCode}）: ${body.slice(0, 180)}`));
        });
        return;
      }

      const totalBytes = Number(res.headers['content-length'] || 0);
      let downloadedBytes = 0;
      let settled = false;
      const output = fs.createWriteStream(targetPath);

      function cleanupAndReject(err) {
        if (settled) return;
        settled = true;
        req.destroy();
        output.destroy();
        try {
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
        } catch (_) {}
        reject(err);
      }

      res.on('data', (chunk) => {
        if (signal && signal.cancelled) {
          cleanupAndReject(createCancelledError());
          return;
        }
        downloadedBytes += chunk.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      res.on('error', cleanupAndReject);
      output.on('error', cleanupAndReject);

      output.on('finish', () => {
        if (settled) return;
        settled = true;
        output.close(() => resolve({ downloadedBytes, totalBytes }));
      });

      res.pipe(output);
    });

    req.on('error', (err) => reject(err));
  });
}

async function downloadToFileWithFallback(urls, targetPath, signal, onProgress) {
  let lastError = null;

  for (const url of urls) {
    try {
      return await downloadFromUrl(url, targetPath, signal, onProgress);
    } catch (err) {
      if (err?.code === DOWNLOAD_CANCELLED_CODE || signal?.cancelled) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error('下载失败');
}

async function downloadSubtitleScheme(
  schemeId,
  {
    signal = { cancelled: false },
    onStatus = () => {},
    onProgress = () => {},
  } = {}
) {
  const scheme = getSubtitleSchemeDefinition(schemeId);
  const writableSchemeDir = getWritableSchemeDir(scheme.schemeId);
  const requiredFiles = scheme.requiredFiles.filter((file) => file.required !== false);
  const progressTracker = createDownloadProgressTracker(requiredFiles);

  clearSchemeFailure(scheme.schemeId);
  ensureDir(writableSchemeDir);

  let completedBytes = 0;
  const initialProgress = progressTracker.getProgress(0);

  setSchemeDownloadState(scheme.schemeId, {
    downloading: true,
    file: '',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: initialProgress.totalBytes,
  });

  try {
    for (const file of requiredFiles) {
      const finalPath = path.join(writableSchemeDir, file.path);
      const tmpPath = `${finalPath}.download`;

      if (signal.cancelled) {
        throw createCancelledError();
      }

      if (fileMatches(finalPath, file.expectedSize || 0)) {
        const fileSize = file.expectedSize || fs.statSync(finalPath).size;
        progressTracker.observeFileTotal(file, fileSize);
        completedBytes += fileSize;
        const progressState = progressTracker.getProgress(completedBytes);
        setSchemeDownloadState(scheme.schemeId, {
          downloading: true,
          file: file.path,
          downloadedBytes: progressState.downloadedBytes,
          totalBytes: progressState.totalBytes,
          percent: progressState.percent,
        });
        onStatus(buildFileStatusMessage(scheme, file.path, '已存在'));
        onProgress({
          schemeId: scheme.schemeId,
          file: file.path,
          downloadedBytes: progressState.downloadedBytes,
          totalBytes: progressState.totalBytes,
          percent: progressState.percent,
        });
        continue;
      }

      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch (_) {}

      const downloadUrls = buildFileDownloadUrls(scheme, file.path);
      if (downloadUrls.length === 0) {
        throw new Error(`${scheme.label} 未配置可用下载源`);
      }

      onStatus(buildFileStatusMessage(scheme, file.path, '下载中'));
      await downloadToFileWithFallback(
        downloadUrls,
        tmpPath,
        signal,
        (fileDownloadedBytes, fileTotalBytes) => {
          const observedFileTotal = getExpectedFileSize(file) || fileTotalBytes || fileDownloadedBytes;
          progressTracker.observeFileTotal(file, observedFileTotal);
          const progressState = progressTracker.getProgress(completedBytes + fileDownloadedBytes);

          setSchemeDownloadState(scheme.schemeId, {
            downloading: true,
            file: file.path,
            downloadedBytes: progressState.downloadedBytes,
            totalBytes: progressState.totalBytes,
            percent: progressState.percent,
          });

          onProgress({
            schemeId: scheme.schemeId,
            file: file.path,
            fileDownloadedBytes,
            fileTotalBytes: observedFileTotal,
            downloadedBytes: progressState.downloadedBytes,
            totalBytes: progressState.totalBytes,
            percent: progressState.percent,
          });
        }
      );

      fs.renameSync(tmpPath, finalPath);

      const finalSize = fs.statSync(finalPath).size;
      if (file.expectedSize && finalSize !== file.expectedSize) {
        throw new Error(`文件校验失败: ${file.path}，期望 ${file.expectedSize} 字节，实际 ${finalSize} 字节`);
      }

      progressTracker.observeFileTotal(file, finalSize);
      completedBytes += file.expectedSize || finalSize;
      const progressState = progressTracker.getProgress(completedBytes);

      setSchemeDownloadState(scheme.schemeId, {
        downloading: true,
        file: file.path,
        downloadedBytes: progressState.downloadedBytes,
        totalBytes: progressState.totalBytes,
        percent: progressState.percent,
      });
      onProgress({
        schemeId: scheme.schemeId,
        file: file.path,
        downloadedBytes: progressState.downloadedBytes,
        totalBytes: progressState.totalBytes,
        percent: progressState.percent,
      });
      onStatus(buildFileStatusMessage(scheme, file.path, '完成'));
    }

    const status = getSubtitleSchemeStatus(scheme.schemeId);
    if (!status.ready) {
      throw new Error(`${scheme.label} 下载未完成，缺少文件: ${status.missingFiles.join(', ')}`);
    }

    clearSchemeFailure(scheme.schemeId);
    clearSchemeDownloadState(scheme.schemeId);
    return status;
  } catch (err) {
    clearSchemeDownloadState(scheme.schemeId);
    if (err?.code !== DOWNLOAD_CANCELLED_CODE) {
      setSchemeFailure(scheme.schemeId, err?.message || `${scheme.label} 下载失败`);
    }
    throw err;
  }
}

function getAsrEngineStatus() {
  return getSubtitleSchemeStatus(DEFAULT_SUBTITLE_SCHEME_ID);
}

function getWritableEngineDir() {
  return getWritableSchemeDir(DEFAULT_SUBTITLE_SCHEME_ID);
}

async function downloadAsrEngine(options = {}) {
  return downloadSubtitleScheme(DEFAULT_SUBTITLE_SCHEME_ID, options);
}

module.exports = {
  DOWNLOAD_CANCELLED_CODE,
  APP_HOME_DIR_NAME,
  MODEL_ROOT_DIR_NAME,
  DEFAULT_SUBTITLE_SCHEME_ID,
  MODEL_DOWNLOAD_SOURCES,
  SUBTITLE_SCHEMES,
  createDownloadProgressTracker,
  getSubtitleSchemes,
  getModelDownloadSource,
  resolveSubtitleSchemeId,
  resolveSubtitleSchemeInfo,
  getCurrentSubtitleScheme,
  setCurrentSubtitleScheme,
  getSubtitleSchemeStatus,
  getAllSubtitleSchemeStatuses,
  getSubtitleSchemeAssets,
  getWritableModelsRoot,
  getWritableSchemeDir,
  getBundledSchemeDir,
  downloadSubtitleScheme,
  getAsrEngineStatus,
  getWritableEngineDir,
  downloadAsrEngine,
};
