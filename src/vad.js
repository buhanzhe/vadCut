/**
 * VAD 工具：使用 sherpa-onnx-node 检测音频中的语音片段
 * 返回第一个和最后一个语音活动的时间戳，用于掐头去尾
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { readMono16kWav } = require('./audioUtils');
const { resolveBundledModelsRoot } = require('./runtimePaths');
const { throwIfCancelled } = require('./taskCancellation');

const MODEL_PATH = path.join(resolveBundledModelsRoot(__dirname), 'silero_vad.onnx');
const SAMPLE_RATE = 16000;
let _sherpaNode = null;

function getSherpaNode() {
  if (!_sherpaNode) {
    _sherpaNode = require('sherpa-onnx-node');
  }
  return _sherpaNode;
}

function createNativeVad(opts = {}, bufferSizeInSeconds = 60) {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(`VAD 模型不存在: ${MODEL_PATH}`);
  }

  return new (getSherpaNode().Vad)({
    sileroVad: {
      model: MODEL_PATH,
      threshold: opts.threshold || 0.9,
      minSilenceDuration: opts.minSilenceDuration || 0.1,
      minSpeechDuration: opts.minSpeechDuration || 0.25,
      maxSpeechDuration: opts.maxSpeechDuration || 30.0,
      windowSize: opts.windowSize || 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: opts.numThreads || 1,
    provider: opts.provider || 'cpu',
    debug: opts.debug || 0,
  }, bufferSizeInSeconds);
}

function getSegmentDuration(seg) {
  return Math.max(0, Number(seg?.end || 0) - Number(seg?.start || 0));
}

function getSegmentGap(prevSeg, nextSeg) {
  return Math.max(0, Number(nextSeg?.start || 0) - Number(prevSeg?.end || 0));
}

function findLeadingKeepIndex(segments, minEdgeSpeechDuration, edgeMergeGapSec) {
  let idx = 0;

  while (idx < segments.length) {
    let clusterEnd = idx;
    let speechDuration = getSegmentDuration(segments[idx]);

    if (speechDuration >= minEdgeSpeechDuration) {
      return idx;
    }

    while (clusterEnd + 1 < segments.length) {
      const nextSeg = segments[clusterEnd + 1];
      if (getSegmentGap(segments[clusterEnd], nextSeg) > edgeMergeGapSec) {
        break;
      }

      clusterEnd += 1;
      speechDuration += getSegmentDuration(segments[clusterEnd]);
      if (speechDuration >= minEdgeSpeechDuration) {
        return idx;
      }
    }

    idx = clusterEnd + 1;
  }

  return segments.length;
}

function findTrailingKeepIndex(segments, minEdgeSpeechDuration, edgeMergeGapSec) {
  let idx = segments.length - 1;

  while (idx >= 0) {
    let clusterStart = idx;
    let speechDuration = getSegmentDuration(segments[idx]);

    if (speechDuration >= minEdgeSpeechDuration) {
      return idx;
    }

    while (clusterStart - 1 >= 0) {
      const prevSeg = segments[clusterStart - 1];
      if (getSegmentGap(prevSeg, segments[clusterStart]) > edgeMergeGapSec) {
        break;
      }

      clusterStart -= 1;
      speechDuration += getSegmentDuration(segments[clusterStart]);
      if (speechDuration >= minEdgeSpeechDuration) {
        return idx;
      }
    }

    idx = clusterStart - 1;
  }

  return -1;
}

function filterEdgeSegments(segments, opts = {}) {
  const minEdgeSpeechDuration = Number.isFinite(opts.minEdgeSpeechDuration)
    ? Math.max(0, opts.minEdgeSpeechDuration)
    : 1.0;
  const edgeMergeGapSec = Number.isFinite(opts.edgeMergeGapSec)
    ? Math.max(0, opts.edgeMergeGapSec)
    : 0.3;

  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      effectiveSegments: [],
      ignoredLeadingSegments: 0,
      ignoredTrailingSegments: 0,
      edgeFilterFallback: false,
    };
  }

  const startIdx = minEdgeSpeechDuration === 0
    ? 0
    : findLeadingKeepIndex(segments, minEdgeSpeechDuration, edgeMergeGapSec);
  const endIdx = minEdgeSpeechDuration === 0
    ? segments.length - 1
    : findTrailingKeepIndex(segments, minEdgeSpeechDuration, edgeMergeGapSec);

  if (startIdx > endIdx) {
    return {
      effectiveSegments: segments.slice(),
      ignoredLeadingSegments: 0,
      ignoredTrailingSegments: 0,
      edgeFilterFallback: true,
    };
  }

  return {
    effectiveSegments: segments.slice(startIdx, endIdx + 1),
    ignoredLeadingSegments: startIdx,
    ignoredTrailingSegments: segments.length - 1 - endIdx,
    edgeFilterFallback: false,
  };
}

function detectSpeechBounds(wavPath, opts = {}) {
  const signal = opts.signal || null;
  const samples = readMono16kWav(wavPath, signal);
  const totalDuration = samples.length / SAMPLE_RATE;
  const vad = createNativeVad(opts, Math.max(60, Math.ceil(totalDuration) + 1));

  const windowSize = opts.windowSize || 512;
  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    if (i % (windowSize * 256) === 0) {
      throwIfCancelled(signal, '任务已取消');
    }
    vad.acceptWaveform(samples.subarray(i, i + windowSize));
  }
  vad.flush();

  const segments = [];
  while (!vad.isEmpty()) {
    throwIfCancelled(signal, '任务已取消');
    const seg = vad.front(false);
    const startSec = seg.start / SAMPLE_RATE;
    const endSec = startSec + seg.samples.length / SAMPLE_RATE;
    segments.push({ start: startSec, end: endSec });
    vad.pop();
  }

  if (segments.length === 0) {
    return {
      firstSpeechTime: 0,
      lastSpeechTime: totalDuration,
      totalDuration,
      segments: [],
      effectiveSegments: [],
      ignoredLeadingSegments: 0,
      ignoredTrailingSegments: 0,
      minEdgeSpeechDuration: 0,
      edgeFilterFallback: false,
    };
  }

  const minEdgeSpeechDuration = Number.isFinite(opts.minEdgeSpeechDuration)
    ? Math.max(0, opts.minEdgeSpeechDuration)
    : 1.0;
  const {
    effectiveSegments,
    ignoredLeadingSegments,
    ignoredTrailingSegments,
    edgeFilterFallback,
  } = filterEdgeSegments(segments, opts);

  const firstSpeechTime = effectiveSegments[0].start;
  const lastSpeechTime = effectiveSegments[effectiveSegments.length - 1].end;

  return {
    firstSpeechTime,
    lastSpeechTime,
    totalDuration,
    segments,
    effectiveSegments,
    ignoredLeadingSegments,
    ignoredTrailingSegments,
    minEdgeSpeechDuration,
    edgeFilterFallback,
  };
}

module.exports = {
  MODEL_PATH,
  SAMPLE_RATE,
  createNativeVad,
  detectSpeechBounds,
  filterEdgeSegments,
};
