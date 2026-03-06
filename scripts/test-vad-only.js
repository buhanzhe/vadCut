'use strict';
/**
 * VAD-only 测试：使用 WASM 包内置 silero_vad.onnx 分割音频，不做 ASR
 * node scripts/test-vad-only.js [视频路径]
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const VIDEO_PATH = process.argv[2] || 'C:\\Users\\bu\\Videos\\语文\\00098.MTS';

const WASM_DIR = path.join(__dirname, '..', 'models',
  'sherpa-onnx-wasm-simd-1.12.28-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small');
const WASM_JS  = path.join(WASM_DIR, 'sherpa-onnx-wasm-main-vad-asr.js');
const VAD_JS   = path.join(WASM_DIR, 'sherpa-onnx-vad.js');

function loadWasm() {
  return new Promise(resolve => {
    const prev = process.cwd();
    process.chdir(WASM_DIR);
    delete require.cache[WASM_JS];
    const M = require(WASM_JS);
    M.setStatus = () => {};
    M.onRuntimeInitialized = () => { process.chdir(prev); resolve(M); };
  });
}

function extractAudio(vid) {
  const tmp = path.join(os.tmpdir(), 'vad_test_' + Date.now() + '.wav');
  return new Promise((res, rej) => {
    const proc = spawn(ffmpegPath,
      ['-i', vid, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmp],
      { windowsHide: true });
    proc.on('close', code => code === 0 ? res(tmp) : rej(new Error('ffmpeg failed')));
    proc.on('error', rej);
  });
}

function readWav(p) {
  const buf = fs.readFileSync(p);
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
  throw new Error('data chunk not found');
}

function fmt(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${sec}`;
}

(async () => {
  console.log('=== VAD-only 测试（silero_vad.onnx，包内默认配置）===');
  console.log(`视频: ${VIDEO_PATH}\n`);

  console.log('加载 WASM 模块...');
  const M = await loadWasm();
  console.log('✓ WASM 就绪');

  const { createVad } = require(VAD_JS);

  console.log('提取 16kHz 音频...');
  const wav = await extractAudio(VIDEO_PATH);
  const samples = readWav(wav);
  fs.unlinkSync(wav);
  const totalSec = samples.length / 16000;
  console.log(`✓ 音频时长: ${totalSec.toFixed(1)}s\n`);

  // 使用包默认配置（createVad 不传 myConfig 时使用内置默认值）
  console.log('初始化 VAD（默认配置：threshold=0.5, minSilence=0.5s, maxSpeech=20s）...');
  const vad = createVad(M);
  console.log('✓ VAD 就绪');

  console.log('喂入音频（512 样本/帧）...');
  const WIN = 512;
  for (let i = 0; i < samples.length; i += WIN) {
    vad.acceptWaveform(samples.subarray(i, i + WIN));
  }
  vad.flush();
  console.log('✓ 音频处理完成\n');

  console.log('── VAD 分段结果 ──────────────────────────────────────');
  let n = 0;
  let totalSpeech = 0;

  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    n++;

    const start = seg.start / 16000;
    const end   = (seg.start + seg.samples.length) / 16000;
    const dur   = end - start;
    totalSpeech += dur;

    console.log(`#${String(n).padStart(2,'0')}  [${fmt(start)} → ${fmt(end)}]  ${dur.toFixed(3)}s  (${seg.samples.length} 样本)`);
  }

  vad.free();

  console.log('─────────────────────────────────────────────────────');
  console.log(`共检测到 ${n} 个语音段`);
  console.log(`总语音时长: ${totalSpeech.toFixed(1)}s / ${totalSec.toFixed(1)}s (${(100*totalSpeech/totalSec).toFixed(1)}%)`);
})().catch(e => { console.error(e); process.exit(1); });
