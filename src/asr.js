'use strict';

/**
 * ASR 模块：使用 sherpa-onnx-node 生成 SRT 字幕
 * - Paraformer / Zipformer：OnlineRecognizer + simulated streaming
 * - SenseVoice / Whisper Turbo：OfflineRecognizer
 */

const path = require('path');
const fs = require('fs');
const sherpaNode = require('sherpa-onnx-node');

const {
  DEFAULT_SUBTITLE_SCHEME_ID,
  getSubtitleSchemeAssets,
  resolveSubtitleSchemeId,
  resolveSubtitleSchemeInfo,
} = require('./asrEngine');
const {
  PREFERRED_ASR_PROVIDER,
  ASR_PROVIDER_FALLBACKS,
} = require('./asrProviderConfig');
const {
  extractAudioToTempWav,
  readMono16kWav,
  safeRemoveFile,
} = require('./audioUtils');
const { detectSubtitleSpeechSegments } = require('./subtitleVad');
const {
  throwIfCancelled,
} = require('./taskCancellation');

const SAMPLE_RATE = 16000;
const FEATURE_DIM = 80;
const DEFAULT_ASR_THREADS = 6;
const ASR_THREAD_FALLBACKS = [6, 4, 2, 1];
const ONLINE_CHUNK_SAMPLES = 1600;
const MAX_SUBTITLE_MERGE_TEXT_CHARS = 20;
const DEFAULT_DECODE_PAD_START_SEC = 0.08;
const DEFAULT_DECODE_PAD_END_SEC = 0.16;
const DEFAULT_DECODE_TAIL_PADDING_SEC = 0.48;
const HEAD_RESCUE_PART_DURATION_SEC = 0.20;
const TAIL_RESCUE_PART_DURATION_SEC = 0.22;
const LOW_TEXT_RESCUE_SEGMENT_DURATION_SEC = 1.0;
const LOW_TEXT_RESCUE_CHAR_COUNT = 4;

const activeThreadCounts = new Map();
const onlineTailPaddingCache = new Map();

function freeNativeHandle(instance) {
  const directTarget = instance && typeof instance.free === 'function' ? instance : null;
  const handleTarget = instance?.handle && typeof instance.handle.free === 'function'
    ? instance.handle
    : null;
  const target = directTarget || handleTarget;

  if (target) {
    try {
      target.free();
    } catch (_) {}
  }
}

function createWhisperRecognizer(assets, numThreads) {
  return new sherpaNode.OfflineRecognizer({
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: FEATURE_DIM,
    },
    modelConfig: {
      whisper: {
        encoder: assets.files.encoder,
        decoder: assets.files.decoder,
        language: '',
        task: 'transcribe',
        tailPaddings: -1,
      },
      tokens: assets.files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
      modelingUnit: 'cjkchar',
      bpeVocab: '',
    },
  });
}

function createSenseVoiceRecognizer(assets, numThreads) {
  return new sherpaNode.OfflineRecognizer({
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: FEATURE_DIM,
    },
    modelConfig: {
      senseVoice: {
        model: assets.files.model,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: assets.files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });
}

function getOfflineParaformerModelPath(assets, provider) {
  if (provider === 'directml') {
    return assets.files.model;
  }
  return assets.files.modelInt8 || assets.files.model;
}

function createOfflineParaformerRecognizer(assets, numThreads, provider) {
  return new sherpaNode.OfflineRecognizer({
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: FEATURE_DIM,
    },
    modelConfig: {
      paraformer: {
        model: getOfflineParaformerModelPath(assets, provider),
      },
      tokens: assets.files.tokens,
      numThreads,
      provider,
      debug: 0,
    },
  });
}

function createParaformerRecognizer(assets, numThreads) {
  return new sherpaNode.OnlineRecognizer({
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: FEATURE_DIM,
    },
    modelConfig: {
      paraformer: {
        encoder: assets.files.encoder,
        decoder: assets.files.decoder,
      },
      tokens: assets.files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
      modelType: 'paraformer',
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 0,
  });
}

function createTransducerRecognizer(assets, numThreads) {
  return new sherpaNode.OnlineRecognizer({
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: FEATURE_DIM,
    },
    modelConfig: {
      transducer: {
        encoder: assets.files.encoder,
        decoder: assets.files.decoder,
        joiner: assets.files.joiner,
      },
      tokens: assets.files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 0,
  });
}

function createRecognizerForScheme(assets, numThreads, provider = 'cpu') {
  switch (assets.scheme.recognizerType) {
    case 'paraformer':
      return createParaformerRecognizer(assets, numThreads);
    case 'transducer':
      return createTransducerRecognizer(assets, numThreads);
    case 'senseVoice':
      return createSenseVoiceRecognizer(assets, numThreads);
    case 'offlineParaformer':
      return createOfflineParaformerRecognizer(assets, numThreads, provider);
    case 'whisper':
    default:
      return createWhisperRecognizer(assets, numThreads);
  }
}

function getPreferredProvidersForScheme(scheme) {
  if (Array.isArray(scheme.providerPreference) && scheme.providerPreference.length > 0) {
    return scheme.providerPreference;
  }

  if (scheme.recognizerType === 'offlineParaformer') {
    const ordered = [
      PREFERRED_ASR_PROVIDER,
      ...ASR_PROVIDER_FALLBACKS,
      'cpu',
    ];
    return Array.from(new Set(ordered.filter((provider) => provider === 'cpu' || provider === 'directml')));
  }

  return ['cpu'];
}

function createRecognizerWithThreadFallback(assets, onLog) {
  const schemeId = assets.scheme.schemeId;
  const schemeLabel = assets.scheme.label;
  const preferredThreadCount = activeThreadCounts.get(schemeId) || DEFAULT_ASR_THREADS;
  const orderedProviders = getPreferredProvidersForScheme(assets.scheme);
  const orderedThreadCounts = [
    preferredThreadCount,
    ...ASR_THREAD_FALLBACKS.filter((count) => count !== preferredThreadCount),
  ];

  let lastError = null;
  for (let providerIndex = 0; providerIndex < orderedProviders.length; providerIndex += 1) {
    const provider = orderedProviders[providerIndex];
    for (let i = 0; i < orderedThreadCounts.length; i += 1) {
      const numThreads = orderedThreadCounts[i];
      try {
        const recognizer = createRecognizerForScheme(assets, numThreads, provider);
        activeThreadCounts.set(schemeId, numThreads);
        return {
          recognizer,
          usedThreads: numThreads,
          usedProvider: provider,
          usedModelPath: assets.scheme.recognizerType === 'offlineParaformer'
            ? getOfflineParaformerModelPath(assets, provider)
            : null,
        };
      } catch (err) {
        lastError = err;
        const nextThreadCount = orderedThreadCounts[i + 1];
        if (nextThreadCount) {
          onLog(`${schemeLabel} provider=${provider} 线程 ${numThreads} 初始化失败，回退到 ${nextThreadCount}`);
        }
      }
    }

    const nextProvider = orderedProviders[providerIndex + 1];
    if (nextProvider) {
      onLog(`${schemeLabel} provider=${provider} 初始化失败，尝试 ${nextProvider}`);
    }
  }

  const detail = lastError?.message ? ` (${lastError.message})` : '';
  throw new Error(`所选方案初始化失败: ${schemeLabel}${detail}`);
}

function reportTranscribeProgress(onProgress, stage, pct, force = false) {
  if (typeof onProgress !== 'function') return;
  onProgress({
    stage,
    pct,
    force,
  });
}

function toSrtTime(sec) {
  const safe = Math.max(0, sec);
  const totalMs = Math.round(safe * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSrt(segments) {
  return segments.map((seg, i) => (
    `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text}`
  )).join('\n\n') + '\n';
}

function secToSamples(sec) {
  return Math.max(0, Math.round((Number(sec) || 0) * SAMPLE_RATE));
}

function formatContextSeconds(sec) {
  return `${Number(sec || 0).toFixed(2)}s`;
}

function getOnlineTailPaddingSamples(sec) {
  const clampedSec = Math.max(0, Number(sec) || 0);
  const cacheKey = clampedSec.toFixed(3);
  if (!onlineTailPaddingCache.has(cacheKey)) {
    onlineTailPaddingCache.set(
      cacheKey,
      new Float32Array(Math.max(0, Math.round(clampedSec * SAMPLE_RATE)))
    );
  }
  return onlineTailPaddingCache.get(cacheKey);
}

function getSchemeDecodeConfig(schemeInfo) {
  return {
    decodePadStartSec: Number.isFinite(schemeInfo.decodePadStartSec)
      ? schemeInfo.decodePadStartSec
      : DEFAULT_DECODE_PAD_START_SEC,
    decodePadEndSec: Number.isFinite(schemeInfo.decodePadEndSec)
      ? schemeInfo.decodePadEndSec
      : DEFAULT_DECODE_PAD_END_SEC,
    decodeTailPaddingSec: Number.isFinite(schemeInfo.decodeTailPaddingSec)
      ? schemeInfo.decodeTailPaddingSec
      : DEFAULT_DECODE_TAIL_PADDING_SEC,
    headRescueSec: Number.isFinite(schemeInfo.headRescueSec)
      ? schemeInfo.headRescueSec
      : 0,
    tailRescueSec: Number.isFinite(schemeInfo.tailRescueSec)
      ? schemeInfo.tailRescueSec
      : 0,
  };
}

function countSubtitleChars(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function joinSubtitleText(leftText, rightText) {
  if (!leftText) return rightText || '';
  if (!rightText) return leftText;

  const needsSpace = /[A-Za-z0-9]$/.test(leftText) && /^[A-Za-z0-9]/.test(rightText);
  return needsSpace ? `${leftText} ${rightText}` : `${leftText}${rightText}`;
}

function mergeRecognizedResultsByCharLimit(results, maxChars = MAX_SUBTITLE_MERGE_TEXT_CHARS) {
  const merged = [];

  for (const item of results) {
    if (!item || !item.text) continue;

    const normalized = {
      start: item.start,
      end: item.end,
      text: String(item.text).trim(),
    };
    if (!normalized.text) continue;

    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push(normalized);
      continue;
    }

    const candidateText = joinSubtitleText(prev.text, normalized.text);
    if (countSubtitleChars(candidateText) <= maxChars) {
      prev.end = normalized.end;
      prev.text = candidateText;
    } else {
      merged.push(normalized);
    }
  }

  return merged;
}

function appendTailPadding(samples, tailPaddingSamples) {
  if (!tailPaddingSamples || tailPaddingSamples.length === 0) {
    return samples;
  }

  const merged = new Float32Array(samples.length + tailPaddingSamples.length);
  merged.set(samples, 0);
  merged.set(tailPaddingSamples, samples.length);
  return merged;
}

function getSegmentSpeechStartSample(seg) {
  return Number.isFinite(seg.speechStartSample) ? seg.speechStartSample : seg.startSample;
}

function getSegmentSpeechEndSample(seg) {
  return Number.isFinite(seg.speechEndSample) ? seg.speechEndSample : seg.endSample;
}

function getSegmentSpeechStartSec(seg) {
  return Number.isFinite(seg.speechStartSec) ? seg.speechStartSec : seg.startSec;
}

function getSegmentSpeechEndSec(seg) {
  return Number.isFinite(seg.speechEndSec) ? seg.speechEndSec : seg.endSec;
}

function getSegmentDecodeStartSample(seg) {
  if (Number.isFinite(seg.decodeStartSample)) return seg.decodeStartSample;
  return getSegmentSpeechStartSample(seg);
}

function getSegmentDecodeEndSample(seg) {
  if (Number.isFinite(seg.decodeEndSample)) return seg.decodeEndSample;
  return getSegmentSpeechEndSample(seg);
}

function getSegmentSpeechDurationSec(seg) {
  return Math.max(0, getSegmentSpeechEndSec(seg) - getSegmentSpeechStartSec(seg));
}

function getPartDurationSec(part) {
  return Math.max(0, Number(part.endSec || 0) - Number(part.startSec || 0));
}

function buildSubtitleResultEntry(seg, text) {
  return {
    start: getSegmentSpeechStartSec(seg),
    end: getSegmentSpeechEndSec(seg),
    text,
  };
}

function normalizeRecognizedText(rawResult) {
  return String(rawResult?.text || '').trim();
}

function splitOverlongRecognizedSegment(seg, recognizer, schemeInfo, samples, tailPaddingSamples, signal = null) {
  const parts = Array.isArray(seg.parts) ? seg.parts : [];
  if (parts.length <= 1) {
    return null;
  }

  const partResults = [];
  for (const part of parts) {
    throwIfCancelled(signal, '字幕提取已取消');
    const partSamples = samples.subarray(part.startSample, part.endSample);
    const rawPartResult = decodeRecognizerSegment(
      recognizer,
      schemeInfo,
      partSamples,
      tailPaddingSamples,
      signal
    );
    const partText = normalizeRecognizedText(rawPartResult);
    if (!partText) continue;

    partResults.push({
      start: part.startSec,
      end: part.endSec,
      text: partText,
    });
  }

  if (partResults.length === 0) {
    return null;
  }

  return mergeRecognizedResultsByCharLimit(partResults);
}

function getSegmentRescueDecision(seg, recognizedText, schemeDecodeConfig) {
  const parts = Array.isArray(seg.parts) ? seg.parts : [];
  const charCount = countSubtitleChars(recognizedText);
  let rescueHead = parts.length > 0
    && schemeDecodeConfig.headRescueSec > 0
    && getPartDurationSec(parts[0]) < HEAD_RESCUE_PART_DURATION_SEC;
  let rescueTail = parts.length > 0
    && schemeDecodeConfig.tailRescueSec > 0
    && getPartDurationSec(parts[parts.length - 1]) < TAIL_RESCUE_PART_DURATION_SEC;

  if (getSegmentSpeechDurationSec(seg) >= LOW_TEXT_RESCUE_SEGMENT_DURATION_SEC && charCount <= LOW_TEXT_RESCUE_CHAR_COUNT) {
    rescueHead = schemeDecodeConfig.headRescueSec > 0;
    rescueTail = schemeDecodeConfig.tailRescueSec > 0;
  }

  return {
    rescueHead,
    rescueTail,
    triggered: rescueHead || rescueTail,
  };
}

function getRescueLabel(rescueHead, rescueTail) {
  if (rescueHead && rescueTail) return '句首/句尾补救';
  if (rescueHead) return '句首补救';
  if (rescueTail) return '句尾补救';
  return '补救';
}

function shouldAdoptRescueResult(originalText, rescueText) {
  if (!rescueText) return false;
  if (!originalText) return true;
  return countSubtitleChars(rescueText) > countSubtitleChars(originalText);
}

function runRescueDecode(
  seg,
  recognizer,
  schemeInfo,
  samples,
  schemeDecodeConfig,
  rescueHead,
  rescueTail,
  tailPaddingSamples,
  signal = null
) {
  const rescueStart = getSegmentDecodeStartSample(seg) - secToSamples(
    rescueHead && schemeDecodeConfig.headRescueSec > 0 ? schemeDecodeConfig.headRescueSec : 0
  );
  const rescueEnd = getSegmentDecodeEndSample(seg) + secToSamples(
    rescueTail && schemeDecodeConfig.tailRescueSec > 0 ? schemeDecodeConfig.tailRescueSec : 0
  );

  const rawRescueResult = decodeRecognizerWindow(
    recognizer,
    schemeInfo,
    samples,
    rescueStart,
    rescueEnd,
    tailPaddingSamples,
    signal
  );
  return normalizeRecognizedText(rawRescueResult);
}

function resolveRecognizedSegmentResults(seg, recognizedText, recognizer, schemeInfo, samples, tailPaddingSamples, signal = null) {
  if (!recognizedText) {
    return [];
  }

  const fallbackResults = countSubtitleChars(recognizedText) > MAX_SUBTITLE_MERGE_TEXT_CHARS
    ? splitOverlongRecognizedSegment(seg, recognizer, schemeInfo, samples, tailPaddingSamples, signal)
    : null;

  if (fallbackResults && fallbackResults.length > 0) {
    return fallbackResults;
  }

  return [buildSubtitleResultEntry(seg, recognizedText)];
}

function decodeOnlineSegment(recognizer, segmentSamples, tailPaddingSamples, signal = null) {
  const stream = recognizer.createStream();
  try {
    const paddedSamples = appendTailPadding(segmentSamples, tailPaddingSamples);
    for (let offset = 0; offset < paddedSamples.length; offset += ONLINE_CHUNK_SAMPLES) {
      throwIfCancelled(signal, '字幕提取已取消');
      const chunk = paddedSamples.subarray(
        offset,
        Math.min(paddedSamples.length, offset + ONLINE_CHUNK_SAMPLES)
      );
      stream.acceptWaveform({
        sampleRate: SAMPLE_RATE,
        samples: chunk,
      });

      while (recognizer.isReady(stream)) {
        throwIfCancelled(signal, '字幕提取已取消');
        recognizer.decode(stream);
      }
    }

    stream.inputFinished();

    let guard = 0;
    while (recognizer.isReady(stream) && guard < 4096) {
      throwIfCancelled(signal, '字幕提取已取消');
      recognizer.decode(stream);
      guard += 1;
    }

    return recognizer.getResult(stream);
  } finally {
    freeNativeHandle(stream);
  }
}

function decodeOfflineSegment(recognizer, segmentSamples, signal = null) {
  const stream = recognizer.createStream();
  try {
    throwIfCancelled(signal, '字幕提取已取消');
    stream.acceptWaveform({
      sampleRate: SAMPLE_RATE,
      samples: segmentSamples,
    });
    throwIfCancelled(signal, '字幕提取已取消');
    recognizer.decode(stream);
    throwIfCancelled(signal, '字幕提取已取消');
    return recognizer.getResult(stream);
  } finally {
    freeNativeHandle(stream);
  }
}

function decodeRecognizerSegment(recognizer, schemeInfo, segmentSamples, tailPaddingSamples, signal = null) {
  return schemeInfo.runtimeType === 'online'
    ? decodeOnlineSegment(recognizer, segmentSamples, tailPaddingSamples, signal)
    : decodeOfflineSegment(recognizer, segmentSamples, signal);
}

function decodeRecognizerWindow(recognizer, schemeInfo, samples, startSample, endSample, tailPaddingSamples, signal = null) {
  const safeStart = Math.max(0, Math.min(samples.length, Math.round(startSample)));
  const safeEnd = Math.max(safeStart, Math.min(samples.length, Math.round(endSample)));
  return decodeRecognizerSegment(
    recognizer,
    schemeInfo,
    samples.subarray(safeStart, safeEnd),
    tailPaddingSamples,
    signal
  );
}

function parseTranscribeOptions(optionsOrOnLog, maybeOnLog) {
  if (typeof optionsOrOnLog === 'function') {
    return {
      options: {},
      onLog: optionsOrOnLog,
    };
  }

  return {
    options: optionsOrOnLog || {},
    onLog: typeof maybeOnLog === 'function' ? maybeOnLog : () => {},
  };
}

/**
 * 对视频文件进行 VAD 分句 + ASR，将结果写入同目录同名 .srt 文件。
 *
 * @param {string} videoPath
 * @param {object|Function} [optionsOrOnLog]
 * @param {string} [optionsOrOnLog.schemeId]
 * @param {Function} [maybeOnLog]
 * @returns {Promise<string|null>}
 */
async function transcribeVideo(videoPath, optionsOrOnLog = {}, maybeOnLog = () => {}) {
  const { options, onLog } = parseTranscribeOptions(optionsOrOnLog, maybeOnLog);
  const schemeId = resolveSubtitleSchemeId(options.schemeId || DEFAULT_SUBTITLE_SCHEME_ID);
  const schemeInfo = resolveSubtitleSchemeInfo(schemeId);
  const assets = getSubtitleSchemeAssets(schemeId);
  const schemeDecodeConfig = getSchemeDecodeConfig(schemeInfo);
  const signal = options.signal || null;
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : null;

  if (!assets.ready) {
    throw new Error(`字幕方案未就绪: ${assets.reason}`);
  }

  const srtPath = videoPath.replace(/\.[^.]+$/, '.srt');
  throwIfCancelled(signal, '字幕提取已取消');
  onLog(`字幕方案: ${schemeInfo.label}`);
  onLog('提取音频...');
  reportTranscribeProgress(onProgress, 'audio', 5, true);

  let wavPath = null;
  let recognizer = null;

  try {
    wavPath = await extractAudioToTempWav(videoPath, { signal });
    throwIfCancelled(signal, '字幕提取已取消');
    reportTranscribeProgress(onProgress, 'audio', 25, true);
    const samples = readMono16kWav(wavPath, signal);
    const totalSec = samples.length / SAMPLE_RATE;
    onLog(`音频时长: ${totalSec.toFixed(1)}s`);
    reportTranscribeProgress(onProgress, 'audio', 35, true);

    onLog('字幕分句（独立 VAD 策略）...');
    const { segments: speechSegs, stats } = detectSubtitleSpeechSegments(samples, {
      signal,
      post: {
        padStartSec: schemeDecodeConfig.decodePadStartSec,
        padEndSec: schemeDecodeConfig.decodePadEndSec,
      },
    });
    onLog(
      `分句优化: 原始 ${stats.rawCount} 段 -> ${stats.finalCount} 段`
      + `（过滤短段 ${stats.droppedShort}，合并相邻 ${stats.mergedCount + stats.overlapMergedCount}）`
    );
    reportTranscribeProgress(onProgress, 'vad', 50, true);

    if (speechSegs.length === 0) {
      reportTranscribeProgress(onProgress, 'asr', 100, true);
      onLog('未检测到语音，跳过 SRT 生成');
      return null;
    }

    throwIfCancelled(signal, '字幕提取已取消');
    onLog(`初始化所选方案: ${schemeInfo.label}...`);
    const created = createRecognizerWithThreadFallback(assets, onLog);
    recognizer = created.recognizer;
    const providerLabel = created.usedProvider ? `，provider: ${created.usedProvider}` : '';
    const modelLabel = created.usedModelPath ? `，模型: ${path.basename(created.usedModelPath)}` : '';
    onLog(`方案就绪: ${schemeInfo.label}，线程数: ${created.usedThreads}${providerLabel}${modelLabel}`);
    if (schemeInfo.runtimeType === 'online') {
      onLog(
        `识别上下文: 前${formatContextSeconds(schemeDecodeConfig.decodePadStartSec)}`
        + ` 后${formatContextSeconds(schemeDecodeConfig.decodePadEndSec)}`
        + ` 尾padding ${formatContextSeconds(schemeDecodeConfig.decodeTailPaddingSec)}`
        + ` 句首补救 ${formatContextSeconds(schemeDecodeConfig.headRescueSec)}`
        + ` 句尾补救 ${formatContextSeconds(schemeDecodeConfig.tailRescueSec)}`
      );
    }
    reportTranscribeProgress(onProgress, 'asr', 60, true);

    onLog(`${schemeInfo.label} 识别中...`);
    const results = [];
    const tailPaddingSamples = schemeInfo.runtimeType === 'online'
      ? getOnlineTailPaddingSamples(schemeDecodeConfig.decodeTailPaddingSec)
      : null;

    for (let i = 0; i < speechSegs.length; i += 1) {
      throwIfCancelled(signal, '字幕提取已取消');
      const seg = speechSegs[i];
      const primaryRawResult = decodeRecognizerSegment(
        recognizer,
        schemeInfo,
        seg.samples,
        tailPaddingSamples,
        signal
      );
      let resolvedText = normalizeRecognizedText(primaryRawResult);

      if (schemeInfo.runtimeType === 'online') {
        const rescueDecision = getSegmentRescueDecision(seg, resolvedText, schemeDecodeConfig);
        if (rescueDecision.triggered) {
          const rescueLabel = getRescueLabel(rescueDecision.rescueHead, rescueDecision.rescueTail);
          onLog(`分句 ${i + 1} 触发${rescueLabel}重识别`);
          const rescueText = runRescueDecode(
            seg,
            recognizer,
            schemeInfo,
            samples,
            schemeDecodeConfig,
            rescueDecision.rescueHead,
            rescueDecision.rescueTail,
            tailPaddingSamples,
            signal
          );

          if (shouldAdoptRescueResult(resolvedText, rescueText)) {
            resolvedText = rescueText;
            onLog(`分句 ${i + 1} 采用${rescueLabel}结果`);
          } else {
            onLog(`分句 ${i + 1} 保留原结果（${rescueLabel}未提升）`);
          }
        }
      }

      const resolvedEntries = resolveRecognizedSegmentResults(
        seg,
        resolvedText,
        recognizer,
        schemeInfo,
        samples,
        tailPaddingSamples,
        signal
      );
      if (resolvedEntries.length > 0) {
        if (countSubtitleChars(resolvedText) > MAX_SUBTITLE_MERGE_TEXT_CHARS && resolvedEntries.length > 1) {
          onLog(`分句过长（>${MAX_SUBTITLE_MERGE_TEXT_CHARS}字），已回退到更细分句`);
        }
        results.push(...resolvedEntries);
      }

      const decodePct = speechSegs.length > 0
        ? 60 + Math.round(((i + 1) / speechSegs.length) * 35)
        : 95;
      reportTranscribeProgress(onProgress, 'asr', decodePct, false);
    }

    throwIfCancelled(signal, '字幕提取已取消');
    freeNativeHandle(recognizer);
    recognizer = null;
    onLog(`识别完成，共 ${results.length} 条字幕`);

    if (results.length > 0) {
      onLog('写入 SRT...');
      reportTranscribeProgress(onProgress, 'asr', 97, true);
      fs.writeFileSync(srtPath, buildSrt(results), 'utf8');
      reportTranscribeProgress(onProgress, 'asr', 100, true);
      onLog(`SRT 已生成: ${path.basename(srtPath)}`);
      return srtPath;
    }

    reportTranscribeProgress(onProgress, 'asr', 100, true);
    onLog('识别结果为空，跳过 SRT 生成');
    return null;
  } finally {
    freeNativeHandle(recognizer);
    safeRemoveFile(wavPath);
  }
}

module.exports = { transcribeVideo };
