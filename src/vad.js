/**
 * VAD 工具：使用 sherpa-onnx-node 检测音频中的语音片段
 * 返回第一个和最后一个语音活动的时间戳，用于掐头去尾
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sherpaNode = require('sherpa-onnx-node');

const { readMono16kWav } = require('./audioUtils');
const { resolveBundledModelsRoot } = require('./runtimePaths');
const { throwIfCancelled } = require('./taskCancellation');

const MODEL_PATH = path.join(resolveBundledModelsRoot(__dirname), 'silero_vad.onnx');
const SAMPLE_RATE = 16000;

function createNativeVad(opts = {}, bufferSizeInSeconds = 60) {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(`VAD 模型不存在: ${MODEL_PATH}`);
  }

  return new sherpaNode.Vad({
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
  const getDuration = (seg) => Math.max(0, seg.end - seg.start);

  let startIdx = 0;
  let endIdx = segments.length - 1;

  while (startIdx <= endIdx && getDuration(segments[startIdx]) < minEdgeSpeechDuration) {
    startIdx += 1;
  }
  while (endIdx >= startIdx && getDuration(segments[endIdx]) < minEdgeSpeechDuration) {
    endIdx -= 1;
  }

  let ignoredLeadingSegments = startIdx;
  let ignoredTrailingSegments = segments.length - 1 - endIdx;
  let edgeFilterFallback = false;
  let effectiveSegments = segments.slice(startIdx, endIdx + 1);

  if (effectiveSegments.length === 0) {
    ignoredLeadingSegments = 0;
    ignoredTrailingSegments = 0;
    edgeFilterFallback = true;
    effectiveSegments = segments;
  }

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
};
