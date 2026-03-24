/**
 * VAD 工具：使用 sherpa-onnx-node 检测音频中的语音片段
 * 返回第一个和最后一个语音活动的时间戳，用于掐头去尾
 */
const path = require('path');
const fs = require('fs');
const sherpaNode = require('sherpa-onnx-node');
const { resolveBundledModelsRoot } = require('./runtimePaths');

// 打包后模型在 resources/models/，开发时在项目根 models/
const MODEL_PATH = path.join(resolveBundledModelsRoot(__dirname), 'silero_vad.onnx');
const SAMPLE_RATE = 16000;

function createNativeVad(opts = {}, bufferSizeInSeconds = 60) {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(
      `VAD 模型文件不存在: ${MODEL_PATH}\n请先运行: npm run setup`
    );
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

/**
 * 读取 WAV 文件，返回 Float32Array 采样数据
 * 只支持 16kHz 单声道 PCM WAV（由 ffmpeg 转换后的格式）
 */
function readWavSamples(wavPath) {
  const buf = fs.readFileSync(wavPath);
  // WAV header: RIFF(4) + size(4) + WAVE(4) + fmt (8+16) + data(8) = 44 bytes
  // 读取 data chunk
  let offset = 12; // skip RIFF header
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      // PCM 16-bit signed little-endian
      const pcmBuf = buf.slice(offset + 8, offset + 8 + chunkSize);
      const samples = new Float32Array(pcmBuf.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = pcmBuf.readInt16LE(i * 2) / 32768.0;
      }
      return samples;
    }
    offset += 8 + chunkSize;
    // align to 2-byte boundary
    if (chunkSize % 2 !== 0) offset += 1;
  }
  throw new Error('WAV 文件中未找到 data chunk: ' + wavPath);
}

/**
 * 检测音频文件中语音的起止时间
 * @param {string} wavPath - 16kHz 单声道 WAV 文件路径
 * @param {object} opts - 选项
 * @returns {{
 *   firstSpeechTime: number,
 *   lastSpeechTime: number,
 *   totalDuration: number,
 *   segments: Array<{ start: number, end: number }>,
 *   effectiveSegments: Array<{ start: number, end: number }>,
 *   ignoredLeadingSegments: number,
 *   ignoredTrailingSegments: number,
 *   minEdgeSpeechDuration: number,
 *   edgeFilterFallback: boolean
 * }}
 *   firstSpeechTime: 第一个语音片段开始时间（秒）
 *   lastSpeechTime:  最后一个语音片段结束时间（秒）
 *   totalDuration:   音频总时长（秒）
 */
function detectSpeechBounds(wavPath, opts = {}) {
  const samples = readWavSamples(wavPath);
  const totalDuration = samples.length / SAMPLE_RATE;
  const vad = createNativeVad(opts, Math.max(60, Math.ceil(totalDuration) + 1));

  // 分块送入 VAD（512 samples = 32ms，匹配 windowSize）
  const windowSize = opts.windowSize || 512;
  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    vad.acceptWaveform(samples.subarray(i, i + windowSize));
  }
  vad.flush();

  const segments = [];
  while (!vad.isEmpty()) {
    // Electron/Node 某些运行时禁用 native external buffer，显式要求拷贝到 JS buffer。
    const seg = vad.front(false);
    // seg.start 单位是采样点数
    const startSec = seg.start / SAMPLE_RATE;
    const endSec = startSec + seg.samples.length / SAMPLE_RATE;
    segments.push({ start: startSec, end: endSec });
    vad.pop();
  }

  if (segments.length === 0) {
    // 没有检测到语音，返回原始时长
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

  // 仅在首尾应用过滤：忽略开头/结尾时长过短的语音段（默认 <1s）
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

  // 极端情况：全部语音段都低于阈值时，回退到原始边界，避免剪辑区间失真
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

module.exports = { detectSpeechBounds, createNativeVad, MODEL_PATH, SAMPLE_RATE };
