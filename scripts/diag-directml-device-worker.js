'use strict';

const path = require('path');

const device = Number(process.env.SHERPA_ONNX_DIRECTML_DEVICE || 0);
const provider = process.env.ASR_PROVIDER || 'directml';
const debug = Number(process.env.ASR_DIRECTML_DEBUG || 0);

process.stderr.write(`[worker] device=${device} provider=${provider} start\n`);

const sherpaNode = require('sherpa-onnx-node');
const { getAsrAssetsForProvider } = require('../src/asrEngine');

const assets = getAsrAssetsForProvider(provider);
if (!assets.ready && !process.env.SHERPA_ONNX_MODEL_PATH) {
  throw new Error(assets.reason);
}

const model = process.env.SHERPA_ONNX_MODEL_PATH
  ? path.resolve(String(process.env.SHERPA_ONNX_MODEL_PATH).trim())
  : assets.modelPath;
const tokens = process.env.SHERPA_ONNX_TOKENS_PATH
  ? path.resolve(String(process.env.SHERPA_ONNX_TOKENS_PATH).trim())
  : assets.tokensPath;

process.stderr.write(`[worker] device=${device} before recognizer\n`);
const recognizer = new sherpaNode.OfflineRecognizer({
  featConfig: {
    sampleRate: 16000,
    featureDim: 80,
  },
  modelConfig: {
    senseVoice: {
      model,
      language: 'auto',
      useInverseTextNormalization: 1,
    },
    tokens,
    numThreads: 2,
    provider,
    debug,
  },
  decodingMethod: 'greedy_search',
});

process.stderr.write(`[worker] device=${device} recognizer created\n`);
if (typeof recognizer.free === 'function') {
  recognizer.free();
}

process.stdout.write(JSON.stringify({
  device,
  provider,
  ok: true,
}));
