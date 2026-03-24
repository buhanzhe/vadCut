'use strict';

/**
 * 字幕提取专用 VAD 分句策略（与剪辑边界检测策略隔离）
 */

const { createNativeVad, SAMPLE_RATE } = require('./vad');
const { throwIfCancelled } = require('./taskCancellation');

const DEFAULT_SUBTITLE_VAD = {
  threshold: 0.5,
  minSilenceDuration: 0.22,
  minSpeechDuration: 0.16,
  maxSpeechDuration: 30,
  windowSize: 512,
  numThreads: 1,
  provider: 'cpu',
};

const DEFAULT_POST_PROCESS = {
  minKeepDurationSec: 0.28,
  mergeGapSec: 0.34,
  maxMergedDurationSec: 20,
  padStartSec: 0.08,
  padEndSec: 0.16,
};

function secToSamples(sec) {
  return Math.max(0, Math.round(sec * SAMPLE_RATE));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getPostProcessConfig(postOpts = {}) {
  return { ...DEFAULT_POST_PROCESS, ...postOpts };
}

function detectRawSpeechRanges(samples, vadOpts = {}, signal = null) {
  const cfg = { ...DEFAULT_SUBTITLE_VAD, ...vadOpts };
  const vad = createNativeVad(cfg, Math.max(60, Math.ceil(samples.length / SAMPLE_RATE) + 1));

  const win = cfg.windowSize;
  for (let i = 0; i < samples.length; i += win) {
    throwIfCancelled(signal, '字幕提取已取消');
    vad.acceptWaveform(samples.subarray(i, i + win));
  }
  vad.flush();

  const ranges = [];
  while (!vad.isEmpty()) {
    throwIfCancelled(signal, '字幕提取已取消');
    // 避免在 Electron 运行时返回 external buffer 导致崩溃。
    const seg = vad.front(false);
    vad.pop();
    ranges.push({
      start: seg.start,
      end: seg.start + seg.samples.length,
    });
  }

  return ranges;
}

function postProcessRanges(rawRanges, totalSamples, postOpts = {}, signal = null) {
  const cfg = getPostProcessConfig(postOpts);
  const minKeepSamples = secToSamples(cfg.minKeepDurationSec);
  const mergeGapSamples = secToSamples(cfg.mergeGapSec);
  const maxMergedSamples = secToSamples(cfg.maxMergedDurationSec);

  const normalized = rawRanges
    .map((r) => ({
      start: clamp(Math.round(r.start), 0, totalSamples),
      end: clamp(Math.round(r.end), 0, totalSamples),
      parts: [{
        start: clamp(Math.round(r.start), 0, totalSamples),
        end: clamp(Math.round(r.end), 0, totalSamples),
      }],
    }))
    .filter((r) => r.end > r.start);

  let droppedShort = 0;
  const kept = normalized.filter((r) => {
    throwIfCancelled(signal, '字幕提取已取消');
    const keep = (r.end - r.start) >= minKeepSamples;
    if (!keep) droppedShort += 1;
    return keep;
  });

  let mergedCount = 0;
  const mergedSpeechRanges = [];
  for (const cur of kept) {
    throwIfCancelled(signal, '字幕提取已取消');
    if (mergedSpeechRanges.length === 0) {
      mergedSpeechRanges.push({
        ...cur,
        parts: cur.parts.map((part) => ({ ...part })),
      });
      continue;
    }

    const prev = mergedSpeechRanges[mergedSpeechRanges.length - 1];
    const gap = cur.start - prev.end;
    const mergedDuration = cur.end - prev.start;
    const canMerge = gap <= mergeGapSamples && mergedDuration <= maxMergedSamples;

    if (canMerge) {
      prev.end = Math.max(prev.end, cur.end);
      prev.parts.push(...cur.parts);
      mergedCount += 1;
    } else {
      mergedSpeechRanges.push({
        ...cur,
        parts: cur.parts.map((part) => ({ ...part })),
      });
    }
  }

  return {
    ranges: mergedSpeechRanges,
    stats: {
      rawCount: rawRanges.length,
      droppedShort,
      mergedCount,
      overlapMergedCount: 0,
      finalCount: mergedSpeechRanges.length,
    },
  };
}

function detectSubtitleSpeechSegments(samples, options = {}) {
  const signal = options.signal || null;
  const postCfg = getPostProcessConfig(options.post);
  const padStartSamples = secToSamples(postCfg.padStartSec);
  const padEndSamples = secToSamples(postCfg.padEndSec);
  const rawRanges = detectRawSpeechRanges(samples, options.vad, signal);
  const { ranges, stats } = postProcessRanges(rawRanges, samples.length, options.post, signal);

  const segments = ranges.map((r) => ({
    startSample: r.start,
    endSample: r.end,
    startSec: r.start / SAMPLE_RATE,
    endSec: r.end / SAMPLE_RATE,
    speechStartSample: r.start,
    speechEndSample: r.end,
    speechStartSec: r.start / SAMPLE_RATE,
    speechEndSec: r.end / SAMPLE_RATE,
    decodeStartSample: clamp(r.start - padStartSamples, 0, samples.length),
    decodeEndSample: clamp(r.end + padEndSamples, 0, samples.length),
    parts: (r.parts || []).map((part) => ({
      startSample: part.start,
      endSample: part.end,
      startSec: part.start / SAMPLE_RATE,
      endSec: part.end / SAMPLE_RATE,
    })),
  })).map((seg) => ({
    ...seg,
    decodeStartSec: seg.decodeStartSample / SAMPLE_RATE,
    decodeEndSec: seg.decodeEndSample / SAMPLE_RATE,
    samples: samples.subarray(seg.decodeStartSample, seg.decodeEndSample),
  }));

  return { segments, stats };
}

module.exports = {
  detectSubtitleSpeechSegments,
  DEFAULT_SUBTITLE_VAD,
  DEFAULT_POST_PROCESS,
};
