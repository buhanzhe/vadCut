'use strict';

const fs = require('fs');
const path = require('path');

const sherpaNode = require('sherpa-onnx-node');

const { extractAudioToTempWav, readMono16kWav, safeRemoveFile } = require('../src/audioUtils');
const { getAsrEngineStatus } = require('../src/asrEngine');
const { detectSubtitleSpeechSegments } = require('../src/subtitleVad');

function createRecognizer(engine) {
  return new sherpaNode.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: path.join(engine.engineDir, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: path.join(engine.engineDir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
}

async function run() {
  const input = (process.argv[2] || '').replace(/^"(.*)"$/, '$1');
  if (!input || !fs.existsSync(input)) {
    throw new Error(`输入视频不存在: ${input}`);
  }

  const engine = getAsrEngineStatus();
  if (!engine.ready) {
    throw new Error('原生引擎未就绪，请先下载模型');
  }

  const wavPath = await extractAudioToTempWav(input);
  try {
    const samples = readMono16kWav(wavPath);

    const tVad0 = process.hrtime.bigint();
    const nativeOut = detectSubtitleSpeechSegments(samples);
    const tVad1 = process.hrtime.bigint();
    const nativeVadMs = Number(tVad1 - tVad0) / 1e6;

    const tInit0 = process.hrtime.bigint();
    const recognizer = createRecognizer(engine);
    const tInit1 = process.hrtime.bigint();
    const initMs = Number(tInit1 - tInit0) / 1e6;

    const tDecode0 = process.hrtime.bigint();
    for (const seg of nativeOut.segments) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({
        sampleRate: 16000,
        samples: seg.samples,
      });
      recognizer.decode(stream);
      recognizer.getResult(stream);
      if (typeof stream.free === 'function') {
        stream.free();
      }
    }
    const tDecode1 = process.hrtime.bigint();
    if (typeof recognizer.free === 'function') {
      recognizer.free();
    }

    const decodeMs = Number(tDecode1 - tDecode0) / 1e6;

    console.log(JSON.stringify({
      native: {
        vadMs: Number(nativeVadMs.toFixed(1)),
        initMs: Number(initMs.toFixed(1)),
        segmentCount: nativeOut.segments.length,
        stats: nativeOut.stats,
        decodeMs: Number(decodeMs.toFixed(1)),
      },
    }, null, 2));
  } finally {
    safeRemoveFile(wavPath);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
