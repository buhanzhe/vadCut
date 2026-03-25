'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runFfmpeg } = require('./ffmpegRunner');
const { throwIfCancelled } = require('./taskCancellation');

const TEMP_DIR = path.join(os.tmpdir(), 'vad-cut');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function makeTempPath(ext) {
  ensureTempDir();
  return path.join(TEMP_DIR, `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

function safeRemoveFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

async function extractAudioToTempWav(videoPath, { signal = null, onProgress = null, durationSec = 0 } = {}) {
  throwIfCancelled(signal, '任务已取消');
  const wavPath = makeTempPath('.wav');

  try {
    await runFfmpeg([
      '-i', videoPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      '-f', 'wav',
      '-y',
      wavPath,
    ], {
      signal,
      onProgress,
      durationSec,
    });

    return wavPath;
  } catch (err) {
    safeRemoveFile(wavPath);
    throw err;
  }
}

function readMono16kWav(wavPath, signal = null) {
  throwIfCancelled(signal, '任务已取消');
  const buffer = fs.readFileSync(wavPath);
  let offset = 12;

  while (offset < buffer.length - 8) {
    throwIfCancelled(signal, '任务已取消');
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      const pcmBuffer = buffer.subarray(offset + 8, offset + 8 + chunkSize);
      const samples = new Float32Array(pcmBuffer.length / 2);
      for (let i = 0; i < samples.length; i += 1) {
        if (i % 8192 === 0) {
          throwIfCancelled(signal, '任务已取消');
        }
        samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768;
      }
      return samples;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) {
      offset += 1;
    }
  }

  throw new Error(`WAV 文件中未找到 data chunk: ${wavPath}`);
}

module.exports = {
  TEMP_DIR,
  extractAudioToTempWav,
  makeTempPath,
  readMono16kWav,
  safeRemoveFile,
};
