'use strict';

/**
 * SenseVoice ASR 字幕测试脚本（WASM 版，VAD 分句）
 *
 * 使用 sherpa-onnx WASM 包（含 VAD + SenseVoice）对视频进行语音识别：
 *   1. Silero VAD 将音频分割为语音段
 *   2. SenseVoice 对每段进行识别，输出精准时间戳
 *
 * 模型目录（已解压）：
 *   models/sherpa-onnx-wasm-simd-1.12.28-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small/
 *
 * 用法：
 *   node scripts/test-asr.js [视频路径]
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ffmpegPath = (() => {
  const p = require('ffmpeg-static');
  return p.replace('app.asar', 'app.asar.unpacked');
})();

const VIDEO_PATH = process.argv[2] || 'C:\\Users\\bu\\Videos\\语文\\00098.MTS';

const WASM_DIR = path.join(
  __dirname, '..', 'models',
  'sherpa-onnx-wasm-simd-1.12.28-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small'
);
const WASM_MAIN_JS = path.join(WASM_DIR, 'sherpa-onnx-wasm-main-vad-asr.js');
const ASR_JS       = path.join(WASM_DIR, 'sherpa-onnx-asr.js');
const VAD_JS       = path.join(WASM_DIR, 'sherpa-onnx-vad.js');

// ─── 1. 加载 WASM 模块 ────────────────────────────────────────────────────────

function loadWasmModule() {
  return new Promise((resolve) => {
    // 切换到 WASM 目录，让 Emscripten 用相对路径找到 .wasm/.data 文件
    const prevCwd = process.cwd();
    process.chdir(WASM_DIR);

    delete require.cache[WASM_MAIN_JS];
    const M = require(WASM_MAIN_JS);

    M.setStatus = (status) => {
      if (status) process.stdout.write(`\r  [WASM] ${status}  `);
      else process.stdout.write('\n');
    };
    M.onRuntimeInitialized = () => {
      process.chdir(prevCwd);
      console.log('✓ WASM 模块初始化完成');
      resolve(M);
    };
  });
}

// ─── 2. 提取音频 ──────────────────────────────────────────────────────────────

function extractAudio(videoPath) {
  const tmpWav = path.join(os.tmpdir(), `asr_test_${Date.now()}.wav`);
  console.log(`\n提取音频: ${path.basename(videoPath)} → 16kHz 单声道 WAV`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', videoPath,
      '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav,
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg 失败:\n${stderr.slice(-500)}`));
      else { console.log(`✓ 音频提取完成: ${tmpWav}`); resolve(tmpWav); }
    });
    proc.on('error', reject);
  });
}

// ─── 3. 读取 WAV ─────────────────────────────────────────────────────────────

function readWavSamples(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId   = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const pcm = buf.subarray(offset + 8, offset + 8 + chunkSize);
      const samples = new Float32Array(pcm.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = pcm.readInt16LE(i * 2) / 32768.0;
      }
      return { samples, sampleRate: 16000 };
    }
    offset += 8 + chunkSize;
  }
  throw new Error('未找到 WAV data chunk');
}

// ─── 4. VAD 分句 + SenseVoice 识别 ───────────────────────────────────────────

async function transcribe(wavPath, Module) {
  const { OfflineRecognizer } = require(ASR_JS);
  const { createVad }         = require(VAD_JS);

  // 4-1. 初始化 VAD
  console.log('\n初始化 Silero VAD...');
  let vad;
  try {
    vad = createVad(Module, {
      sileroVad: {
        model:              './silero_vad.onnx',
        threshold:          0.50,
        minSilenceDuration: 0.50,
        minSpeechDuration:  0.25,
        maxSpeechDuration:  20,
        windowSize:         512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider:   'cpu',
      debug:      0,
    });
  } catch (e) {
    throw new Error(`VAD 初始化失败: ${e && e.message || JSON.stringify(e)}`);
  }
  console.log('✓ VAD 就绪');

  // 4-2. 初始化 SenseVoice 识别器
  console.log('初始化 SenseVoice 识别器...');
  let recognizer;
  try {
    recognizer = new OfflineRecognizer({
      modelConfig: {
        senseVoice: {
          model: './sense-voice.onnx',
          useInverseTextNormalization: 1,
        },
        tokens:     './tokens.txt',
        numThreads: 1,
        provider:   'cpu',
        debug:      0,
      },
      decodingMethod: 'greedy_search',
    }, Module);
  } catch (e) {
    throw new Error(`OfflineRecognizer 初始化失败: ${e && e.message || JSON.stringify(e)}`);
  }
  console.log('✓ 识别器就绪');

  const { samples, sampleRate } = readWavSamples(wavPath);
  const totalSec = samples.length / sampleRate;
  console.log(`\n音频时长: ${totalSec.toFixed(1)}s，开始 VAD 分句...`);

  // 4-3. 按 512 样本窗口喂给 VAD
  const WINDOW = 512;
  for (let i = 0; i < samples.length; i += WINDOW) {
    vad.acceptWaveform(samples.subarray(i, i + WINDOW));
  }
  vad.flush();

  // 4-4. 收集所有语音段，逐段识别
  const results = [];
  let segCount = 0;

  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    segCount++;

    const startSec = seg.start / sampleRate;
    const endSec   = (seg.start + seg.samples.length) / sampleRate;
    process.stdout.write(`[${fmt(startSec)} → ${fmt(endSec)}] 识别中...`);

    const stream = recognizer.createStream();
    stream.acceptWaveform(sampleRate, seg.samples);
    recognizer.decode(stream);
    const r = recognizer.getResult(stream);
    stream.free();

    const text = (r.text || '').trim();
    process.stdout.write(`\r[${fmt(startSec)} → ${fmt(endSec)}] ${text || '（静音）'}\n`);
    if (text) results.push({ start: startSec, end: endSec, text });
  }

  recognizer.free();
  console.log(`\nVAD 共检测到 ${segCount} 个语音段`);
  return results;
}

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${s.padStart(6,'0')}`;
}

// ─── 5. 输出 SRT ──────────────────────────────────────────────────────────────

function writeSrt(results, videoPath) {
  const srtPath = videoPath.replace(/\.[^.]+$/, '') + '_asr.srt';
  const lines = [];
  results.forEach((r, i) => {
    const start = fmt(r.start).replace('.', ',');
    const end   = fmt(r.end).replace('.', ',');
    lines.push(`${i + 1}\n${start} --> ${end}\n${r.text}\n`);
  });
  fs.writeFileSync(srtPath, lines.join('\n'), 'utf8');
  return srtPath;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== sherpa-onnx SenseVoice WASM ASR（VAD 分句）===');
  console.log(`视频: ${VIDEO_PATH}\n`);

  if (!fs.existsSync(VIDEO_PATH)) {
    console.error(`错误: 视频文件不存在: ${VIDEO_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(WASM_MAIN_JS)) {
    console.error(`错误: WASM 包未解压，请先运行:\n  tar -xjf models/sherpa-onnx-wasm-simd-*.tar.bz2 -C models/`);
    process.exit(1);
  }

  try {
    console.log('加载 WASM 模块（含 VAD + SenseVoice 模型，首次约需数秒）...');
    const Module = await loadWasmModule();

    const wavPath = await extractAudio(VIDEO_PATH);

    const t0 = Date.now();
    const results = await transcribe(wavPath, Module);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    try { fs.unlinkSync(wavPath); } catch (_) {}

    console.log(`识别完成，共 ${results.length} 段有效字幕，耗时 ${elapsed}s`);
    if (results.length > 0) {
      const srtPath = writeSrt(results, VIDEO_PATH);
      console.log(`SRT 字幕已保存: ${srtPath}`);
    } else {
      console.log('未识别到语音内容');
    }
  } catch (err) {
    console.error(`\n错误: ${err && err.message || err}`);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
