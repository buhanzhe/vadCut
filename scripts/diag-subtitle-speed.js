'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sherpaNode = require('sherpa-onnx-node');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const { detectSubtitleSpeechSegments } = require('../src/subtitleVad');
const { getAsrEngineStatus } = require('../src/asrEngine');

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit=${code}\n${stderr}`));
    });
  });
}

async function extractAudioWav(videoPath) {
  const wavPath = path.join(os.tmpdir(), `vadcut_diag_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  await runCommand(ffmpegPath, [
    '-i', videoPath,
    '-vn', '-ar', '16000', '-ac', '1',
    '-f', 'wav', '-y', wavPath,
  ]);
  return wavPath;
}

function readWavSamples(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const pcm = buf.subarray(off + 8, off + 8 + sz);
      const f32 = new Float32Array(pcm.length / 2);
      for (let i = 0; i < f32.length; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768;
      return f32;
    }
    off += 8 + sz;
  }
  throw new Error('WAV data chunk 未找到');
}

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

  const wavPath = await extractAudioWav(input);
  try {
    const samples = readWavSamples(wavPath);

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
    try { fs.unlinkSync(wavPath); } catch (_) {}
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
