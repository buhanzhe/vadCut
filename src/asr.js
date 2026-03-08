'use strict';

/**
 * ASR 模块：使用 sherpa-onnx WASM 包（VAD + SenseVoice）对视频生成 SRT 字幕
 *
 * - WASM 模块为进程级单例，首次调用时懒加载
 * - VAD / 识别器每次调用新建、用完释放，不跨次共享
 * - 调用方可并发调用 transcribeVideo()；WASM 本身单线程，各实例数据独立无干扰
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn } = require('child_process');

const ffmpegPath = (() => {
  const p = require('ffmpeg-static');
  return p.replace('app.asar', 'app.asar.unpacked');
})();

const { app: _electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();

// 打包后模型在 resources/models/，开发时在项目根 models/
const _modelsRoot = (_electronApp && _electronApp.isPackaged)
  ? path.join(process.resourcesPath, 'models')
  : path.join(__dirname, '..', 'models');

const WASM_DIR = path.join(
  _modelsRoot,
  'sherpa-onnx-wasm-simd-1.12.28-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small'
);
const WASM_JS = path.join(WASM_DIR, 'sherpa-onnx-wasm-main-vad-asr.js');
const ASR_JS  = path.join(WASM_DIR, 'sherpa-onnx-asr.js');
const VAD_JS  = path.join(WASM_DIR, 'sherpa-onnx-vad.js');

// ─── WASM 单例 ────────────────────────────────────────────────────────────────

let _module  = null;
let _loading = null;

/**
 * 懒加载 WASM 模块（进程内只加载一次）
 * @returns {Promise<object>} Emscripten Module
 */
function loadWasmModule() {
  if (_module)  return Promise.resolve(_module);
  if (_loading) return _loading;

  _loading = new Promise((resolve, reject) => {
    const prev = process.cwd();
    process.chdir(WASM_DIR);

    delete require.cache[WASM_JS];
    let M;
    try {
      M = require(WASM_JS);
    } catch (e) {
      process.chdir(prev);
      reject(e);
      return;
    }

    M.setStatus = () => {};
    M.onRuntimeInitialized = () => {
      process.chdir(prev);
      _module = M;
      resolve(M);
    };
  });

  return _loading;
}

// ─── 音频提取 ─────────────────────────────────────────────────────────────────

function extractAudioWav(videoPath) {
  const tmp = path.join(
    os.tmpdir(),
    `asr_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
  );
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', videoPath,
      '-vn', '-ar', '16000', '-ac', '1',
      '-f', 'wav', '-y', tmp,
    ], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg 音频提取失败: ${stderr.slice(-300)}`));
      else resolve(tmp);
    });
    proc.on('error', reject);
  });
}

// ─── WAV 解码 ─────────────────────────────────────────────────────────────────

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

// ─── SRT 格式化 ───────────────────────────────────────────────────────────────

function toSrtTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function buildSrt(segments) {
  return segments.map((seg, i) =>
    `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text}`
  ).join('\n\n') + '\n';
}

// ─── 核心：VAD 分句 + SenseVoice 识别 ────────────────────────────────────────

/**
 * 对视频文件进行 VAD 分句 + ASR，将结果写入同目录同名 .srt 文件。
 *
 * @param {string}   videoPath  剪辑后的视频路径
 * @param {Function} [onLog]    日志回调 (msg: string) => void
 * @returns {Promise<string>}   SRT 文件路径
 */
async function transcribeVideo(videoPath, onLog = () => {}) {
  if (!fs.existsSync(WASM_JS)) {
    throw new Error(`WASM 包未找到，请解压模型包到 models/ 目录下`);
  }

  const srtPath = videoPath.replace(/\.[^.]+$/, '.srt');

  // 1. 加载 WASM
  onLog('加载 ASR 引擎（首次约需数秒）...');
  const M = await loadWasmModule();
  const { OfflineRecognizer } = require(ASR_JS);
  const { createVad }         = require(VAD_JS);

  // 2. 提取音频
  onLog('提取音频...');
  const wavPath = await extractAudioWav(videoPath);

  try {
    const samples = readWavSamples(wavPath);
    const totalSec = samples.length / 16000;
    onLog(`音频时长: ${totalSec.toFixed(1)}s`);

    // 3. VAD（与 vad.js 保持一致：threshold=0.9, minSilence=0.1s）
    onLog('VAD 分句...');
    const vad = createVad(M, {
      sileroVad: {
        model: './silero_vad.onnx',
        threshold: 0.9,
        minSilenceDuration: 0.1,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    });

    const WIN = 512;
    for (let i = 0; i < samples.length; i += WIN) {
      vad.acceptWaveform(samples.subarray(i, i + WIN));
    }
    vad.flush();

    // 4. 收集语音段
    const speechSegs = [];
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      speechSegs.push(seg);
    }
    vad.free();
    onLog(`VAD 检测到 ${speechSegs.length} 个语音段`);

    if (speechSegs.length === 0) {
      onLog('未检测到语音，跳过 SRT 生成');
      return null;
    }

    // 5. SenseVoice 识别（sense-voice.onnx + tokens.txt 已嵌入 .data）
    onLog('SenseVoice 识别中...');
    const recognizer = new OfflineRecognizer({
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
    }, M);

    const results = [];
    for (const seg of speechSegs) {
      const startSec = seg.start / 16000;
      const endSec   = (seg.start + seg.samples.length) / 16000;

      const stream = recognizer.createStream();
      stream.acceptWaveform(16000, seg.samples);
      recognizer.decode(stream);
      const r = recognizer.getResult(stream);
      stream.free();

      const text = (r.text || '').trim();
      if (text) results.push({ start: startSec, end: endSec, text });
    }

    recognizer.free();
    onLog(`识别完成，共 ${results.length} 条字幕`);

    // 6. 写 SRT
    if (results.length > 0) {
      fs.writeFileSync(srtPath, buildSrt(results), 'utf8');
      onLog(`SRT 已生成: ${path.basename(srtPath)}`);
      return srtPath;
    }

    onLog('识别结果为空，跳过 SRT 生成');
    return null;

  } finally {
    try { fs.unlinkSync(wavPath); } catch (_) {}
  }
}

module.exports = { transcribeVideo, loadWasmModule };
