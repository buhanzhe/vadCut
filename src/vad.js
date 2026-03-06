/**
 * VAD 工具：使用 sherpa-onnx 检测音频中的语音片段
 * 返回第一个和最后一个语音活动的时间戳，用于掐头去尾
 */
const path = require('path');
const fs = require('fs');
const { app } = (() => { try { return require('electron'); } catch { return {}; } })();

// 打包后模型在 resources/models/，开发时在项目根 models/
const MODEL_PATH = (app && app.isPackaged)
  ? path.join(process.resourcesPath, 'models', 'silero_vad.onnx')
  : path.join(__dirname, '..', 'models', 'silero_vad.onnx');
const SAMPLE_RATE = 16000;

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
 * @returns {{ firstSpeechTime: number, lastSpeechTime: number, totalDuration: number }}
 *   firstSpeechTime: 第一个语音片段开始时间（秒）
 *   lastSpeechTime:  最后一个语音片段结束时间（秒）
 *   totalDuration:   音频总时长（秒）
 */
function detectSpeechBounds(wavPath, opts = {}) {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(
      `VAD 模型文件不存在: ${MODEL_PATH}\n请先运行: npm run setup`
    );
  }

  const sherpa = require('sherpa-onnx');

  const config = {
    sileroVad: {
      model: MODEL_PATH,
      threshold: opts.threshold || 0.4,
      minSilenceDuration: opts.minSilenceDuration || 0.3,
      minSpeechDuration: opts.minSpeechDuration || 0.25,
      maxSpeechDuration: opts.maxSpeechDuration || 30.0,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  };

  // bufferSizeInSeconds: 缓冲区大小，60秒足够大
  const vad = sherpa.createVad(config, 60);

  const samples = readWavSamples(wavPath);
  const totalDuration = samples.length / SAMPLE_RATE;

  // 分块送入 VAD（512 samples = 32ms，匹配 windowSize）
  const windowSize = 512;
  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    vad.acceptWaveform(samples.slice(i, i + windowSize));
  }
  vad.flush();

  const segments = [];
  while (!vad.isEmpty()) {
    const seg = vad.front();
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
    };
  }

  const firstSpeechTime = segments[0].start;
  const lastSpeechTime = segments[segments.length - 1].end;

  return {
    firstSpeechTime,
    lastSpeechTime,
    totalDuration,
    segments,
  };
}

module.exports = { detectSpeechBounds, MODEL_PATH, SAMPLE_RATE };
