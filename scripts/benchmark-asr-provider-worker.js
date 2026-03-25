'use strict';

const fs = require('fs');
const path = require('path');

const sherpaNode = require('sherpa-onnx-node');

const { extractAudioToTempWav, readMono16kWav, safeRemoveFile } = require('../src/audioUtils');
const { getAsrAssetsForProvider } = require('../src/asrEngine');
const { detectSubtitleSpeechSegments } = require('../src/subtitleVad');

function parseArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx === process.argv.length - 1) return fallback;
  return String(process.argv[idx + 1] || fallback);
}

function freeStream(stream) {
  if (stream && typeof stream.free === 'function') {
    stream.free();
  }
}

function freeRecognizer(recognizer) {
  if (recognizer && typeof recognizer.free === 'function') {
    recognizer.free();
  }
}

function createRecognizer(modelPath, tokensPath, provider) {
  return new sherpaNode.OfflineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      senseVoice: {
        model: modelPath,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: tokensPath,
      numThreads: 2,
      provider,
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
}

function measureSync(fn) {
  const t0 = process.hrtime.bigint();
  const result = fn();
  const t1 = process.hrtime.bigint();
  return { result, ms: Number(t1 - t0) / 1e6 };
}

async function measureAsync(fn) {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  const t1 = process.hrtime.bigint();
  return { result, ms: Number(t1 - t0) / 1e6 };
}

function average(list) {
  if (!list.length) return 0;
  return list.reduce((sum, item) => sum + item, 0) / list.length;
}

async function benchmarkProvider({ provider, videoPath, modelPath, tokensPath, rounds }) {
  const runs = [];
  let audioSec = 0;
  let segmentCount = 0;

  for (let i = 0; i < rounds; i += 1) {
    let recognizer = null;
    const extract = await measureAsync(() => extractAudioToTempWav(videoPath));
    const wavPath = extract.result;

    try {
      const samplesRead = measureSync(() => readMono16kWav(wavPath));
      audioSec = samplesRead.result.length / 16000;

      const vad = measureSync(() => detectSubtitleSpeechSegments(samplesRead.result));
      const segments = vad.result.segments;
      segmentCount = segments.length;

      const init = measureSync(() => createRecognizer(modelPath, tokensPath, provider));
      recognizer = init.result;

      let recognizedSegments = 0;
      const decodeStart = process.hrtime.bigint();
      for (const seg of segments) {
        const stream = recognizer.createStream();
        try {
          stream.acceptWaveform({
            sampleRate: 16000,
            samples: seg.samples,
          });
          recognizer.decode(stream);
          const result = recognizer.getResult(stream);
          if ((result.text || '').trim()) {
            recognizedSegments += 1;
          }
        } finally {
          freeStream(stream);
        }
      }
      const decodeMs = Number(process.hrtime.bigint() - decodeStart) / 1e6;
      const totalMs = extract.ms + samplesRead.ms + vad.ms + init.ms + decodeMs;

      runs.push({
        extractMs: extract.ms,
        readWavMs: samplesRead.ms,
        vadMs: vad.ms,
        initMs: init.ms,
        decodeMs,
        totalMs,
        recognizedSegments,
        segmentCount,
        audioSec,
      });
    } finally {
      freeRecognizer(recognizer);
      safeRemoveFile(wavPath);
    }
  }

  const warmRuns = runs.slice(1);
  return {
    provider,
    rounds,
    audioSec,
    segmentCount,
    cold: runs[0],
    warmAverage: {
      extractMs: average(warmRuns.map((r) => r.extractMs)),
      readWavMs: average(warmRuns.map((r) => r.readWavMs)),
      vadMs: average(warmRuns.map((r) => r.vadMs)),
      initMs: average(warmRuns.map((r) => r.initMs)),
      decodeMs: average(warmRuns.map((r) => r.decodeMs)),
      totalMs: average(warmRuns.map((r) => r.totalMs)),
    },
    runs,
  };
}

async function main() {
  const provider = parseArg('--provider', 'cpu');
  const videoPath = parseArg('--video');
  const rounds = Number(parseArg('--rounds', '3')) || 3;
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`输入视频不存在: ${videoPath}`);
  }

  const assets = getAsrAssetsForProvider(provider);
  const modelPath = process.env.SHERPA_ONNX_MODEL_PATH
    ? path.resolve(String(process.env.SHERPA_ONNX_MODEL_PATH).trim())
    : assets.modelPath;
  const tokensPath = process.env.SHERPA_ONNX_TOKENS_PATH
    ? path.resolve(String(process.env.SHERPA_ONNX_TOKENS_PATH).trim())
    : assets.tokensPath;

  if (!assets.ready && !process.env.SHERPA_ONNX_MODEL_PATH) {
    throw new Error(assets.reason);
  }

  const result = await benchmarkProvider({
    provider,
    videoPath,
    modelPath,
    tokensPath,
    rounds,
  });

  process.stdout.write(JSON.stringify({
    ...result,
    modelVariant: assets.variant,
    modelPath,
  }));
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
