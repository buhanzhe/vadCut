'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const { transcribeVideo } = require('../src/asr');
const { getAsrEngineStatus, downloadAsrEngine } = require('../src/asrEngine');

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} 退出码 ${code}\n${stderr || stdout}`));
    });
  });
}

async function ensureNativeEngine() {
  const status = getAsrEngineStatus();
  if (status.ready) return status;

  console.log('[setup] 原生引擎缺失，开始下载...');
  let lastPct = -1;
  await downloadAsrEngine({
    onStatus(msg) { process.stdout.write(`\n[setup] ${msg}`); },
    onProgress(progress) {
      const pct = Number(progress.percent || 0);
      if (pct !== lastPct) {
        process.stdout.write(`\r[setup] 下载进度 ${String(pct).padStart(3, ' ')}%`);
        lastPct = pct;
      }
    },
  });
  process.stdout.write('\n');
  return getAsrEngineStatus();
}

async function synthSpeechWav(wavPath) {
  const vbsPath = path.join(os.tmpdir(), `vadcut_speech_${Date.now()}.vbs`);
  const spokenText = [
    'Hello and welcome to this benchmark.',
    'We are testing native subtitle extraction speed.',
    'This sentence is repeated for stable timing comparison.',
    'Hello and welcome to this benchmark.',
    'We are testing native subtitle extraction speed.',
  ].join(' ');

  const script = [
    'Set v = CreateObject("SAPI.SpVoice")',
    'v.Rate = 0',
    'Set s = CreateObject("SAPI.SpFileStream")',
    `s.Open "${wavPath.replace(/\\/g, '\\\\')}", 3, False`,
    'Set v.AudioOutputStream = s',
    `v.Speak "${spokenText.replace(/"/g, '""')}"`,
    's.Close',
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, script, 'utf8');

  try {
    await runCommand('cscript', ['//nologo', vbsPath]);
  } finally {
    try { fs.unlinkSync(vbsPath); } catch (_) {}
  }
}

async function makeSampleVideo(videoPath) {
  const wavPath = path.join(os.tmpdir(), `vadcut_bench_speech_${Date.now()}.wav`);
  await synthSpeechWav(wavPath);
  try {
    await runCommand(ffmpegPath, [
      '-f', 'lavfi',
      '-i', 'color=size=1280x720:rate=25:color=black',
      '-i', wavPath,
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y',
      videoPath,
    ]);
  } finally {
    try { fs.unlinkSync(wavPath); } catch (_) {}
  }
}

async function measure(name, fn, rounds = 3) {
  const msList = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    msList.push(ms);
    console.log(`[${name}] run ${i + 1}/${rounds}: ${ms.toFixed(1)} ms`);
  }

  const cold = msList[0];
  const warm = msList.slice(1);
  const avgWarm = warm.length ? warm.reduce((a, b) => a + b, 0) / warm.length : cold;
  return { cold, avgWarm, all: msList };
}

function fmt(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  await ensureNativeEngine();

  const userInputVideoRaw = process.argv[2] || '';
  const userInputVideo = userInputVideoRaw.replace(/^"(.*)"$/, '$1');
  const tempDir = path.join(os.tmpdir(), `vadcut_bench_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const sampleVideo = path.join(tempDir, 'sample.mp4');
  let cleanupSampleVideo = true;

  if (userInputVideo) {
    if (!fs.existsSync(userInputVideo)) {
      throw new Error(`输入视频不存在: ${userInputVideo}`);
    }
    fs.copyFileSync(userInputVideo, sampleVideo);
    console.log(`[setup] 使用用户输入视频: ${userInputVideo}`);
  } else {
    console.log('[setup] 生成测试视频...');
    await makeSampleVideo(sampleVideo);
    console.log(`[setup] 测试视频: ${sampleVideo}`);
  }

  const nativeVideo = path.join(tempDir, 'sample_native.mp4');
  fs.copyFileSync(sampleVideo, nativeVideo);

  const nativeResult = await measure('native', async () => {
    await transcribeVideo(nativeVideo, () => {});
  });

  console.log('\n=== Benchmark Summary ===');
  console.log(`native cold: ${fmt(nativeResult.cold)} | warm avg: ${fmt(nativeResult.avgWarm)}`);

  for (const target of [
    ...(cleanupSampleVideo ? [sampleVideo] : []),
    nativeVideo,
    nativeVideo.replace(/\.[^.]+$/, '.srt'),
  ]) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
  }
  try { fs.rmdirSync(tempDir); } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
