'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const { getAsrEngineStatus } = require('../src/asrEngine');

const PROVIDERS = ['directml', 'cpu'];
const BENCH_ROUNDS = Number(process.env.ASR_BENCH_ROUNDS || 3);
const WORKER_PATH = path.join(__dirname, 'benchmark-asr-provider-worker.js');

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}\n${stderr}`));
    });
  });
}

async function synthSpeechWav(wavPath) {
  const vbsPath = path.join(os.tmpdir(), `vadcut_provider_bench_${Date.now()}.vbs`);
  const spokenText = [
    'Hello and welcome to this provider benchmark.',
    'We are testing DirectML against CPU for subtitle generation.',
    'This sentence is repeated to produce a stable workload.',
    'Hello and welcome to this provider benchmark.',
    'We are testing DirectML against CPU for subtitle generation.',
    'This sentence is repeated to produce a stable workload.',
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
  const wavPath = path.join(os.tmpdir(), `vadcut_provider_bench_${Date.now()}.wav`);
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

function realtimeFactor(audioSec, totalMs) {
  if (!audioSec || !totalMs) return 0;
  return audioSec / (totalMs / 1000);
}

async function benchmarkProvider({ provider, videoPath, rounds }) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [
      WORKER_PATH,
      '--provider', provider,
      '--video', videoPath,
      '--rounds', String(rounds),
    ], {
      cwd: process.cwd(),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (error) => {
      resolve({
        provider,
        available: false,
        error: error && error.message ? error.message : String(error),
      });
    });
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        const fallbackToCpu = /Fallback to cpu/i.test(stderr);
        const directmlInitFailed = /Failed to enable DirectML/i.test(stderr);
        resolve({
          ...parsed,
          available: true,
          providerActivated: !fallbackToCpu,
          fallbackToCpu,
          notes: directmlInitFailed ? 'DirectML 初始化失败并回退到 CPU' : '',
        });
      } catch (error) {
        resolve({
          provider,
          available: false,
          error: (stderr || stdout || (error && error.message) || '未知错误').trim(),
        });
      }
    });
  });
}

function pickWinner(results) {
  const available = results.filter((r) => r.available && r.providerActivated !== false);
  if (available.length === 0) return null;

  return available.slice().sort((a, b) => {
    const warmDiff = a.warmAverage.totalMs - b.warmAverage.totalMs;
    if (Math.abs(warmDiff) > 0.001) return warmDiff;
    return a.cold.totalMs - b.cold.totalMs;
  })[0];
}

async function prepareInput() {
  const inputArg = (process.argv[2] || '').replace(/^"(.*)"$/, '$1');
  if (inputArg) {
    if (!fs.existsSync(inputArg)) {
      throw new Error(`输入视频不存在: ${inputArg}`);
    }
    return { videoPath: inputArg, cleanup: [] };
  }

  const tempDir = path.join(os.tmpdir(), `vadcut_provider_bench_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const sampleVideo = path.join(tempDir, 'sample.mp4');
  await makeSampleVideo(sampleVideo);
  return { videoPath: sampleVideo, cleanup: [sampleVideo, tempDir] };
}

async function main() {
  const engineStatus = getAsrEngineStatus();
  if (!engineStatus.ready) {
    throw new Error(`字幕引擎未就绪，缺少: ${engineStatus.missingFiles.join(', ')}`);
  }

  const { videoPath, cleanup } = await prepareInput();
  try {
    const results = [];
    for (const provider of PROVIDERS) {
      const result = await benchmarkProvider({ provider, videoPath, rounds: BENCH_ROUNDS });
      results.push(result);

      if (!result.available) {
        console.log(`[${provider}] unavailable: ${result.error}`);
        continue;
      }

      for (let i = 0; i < result.runs.length; i++) {
        const run = result.runs[i];
        console.log(
          `[${provider}] run ${i + 1}/${BENCH_ROUNDS}: ` +
          `extract ${run.extractMs.toFixed(1)} ms, ` +
          `vad ${run.vadMs.toFixed(1)} ms, ` +
          `init ${run.initMs.toFixed(1)} ms, ` +
          `decode ${run.decodeMs.toFixed(1)} ms, ` +
          `total ${run.totalMs.toFixed(1)} ms`
        );
      }
    }

    const winner = pickWinner(results);
    const firstAvailable = results.find((r) => r.available);
    const summary = {
      benchmarkedAt: new Date().toISOString(),
      videoPath,
      rounds: BENCH_ROUNDS,
      audioSec: firstAvailable ? firstAvailable.audioSec : 0,
      segmentCount: firstAvailable ? firstAvailable.segmentCount : 0,
      results,
      recommendedProvider: winner ? winner.provider : null,
    };

    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
    const outputPath = path.join(process.cwd(), '.tmp', 'asr-provider-benchmark.json');
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');

    console.log(`视频: ${videoPath}`);
    console.log(`音频时长: ${summary.audioSec.toFixed(2)} s`);
    console.log(`字幕分句: ${summary.segmentCount} 段`);
    console.log('\n=== Provider Benchmark Summary ===');
    for (const result of results) {
      if (!result.available) {
        console.log(`[${result.provider}] unavailable: ${result.error}`);
        continue;
      }
      const coldX = realtimeFactor(result.audioSec, result.cold.totalMs);
      const warmX = realtimeFactor(result.audioSec, result.warmAverage.totalMs);
      console.log(
        `[${result.provider}] cold ${result.cold.totalMs.toFixed(1)} ms (${coldX.toFixed(2)}x realtime), ` +
        `warm avg ${result.warmAverage.totalMs.toFixed(1)} ms (${warmX.toFixed(2)}x realtime)`
      );
      if (result.fallbackToCpu) {
        console.log(`[${result.provider}] requested provider fell back to cpu; this result is not counted as a valid DirectML benchmark`);
      }
    }

    if (winner) {
      console.log(`recommended provider: ${winner.provider}`);
    } else {
      console.log('recommended provider: none (no provider activated successfully)');
    }
    console.log(`summary file: ${outputPath}`);
  } finally {
    for (const target of cleanup) {
      try {
        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
          fs.unlinkSync(target);
        }
      } catch (_) {}
    }
    for (const target of cleanup.slice().reverse()) {
      try {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          fs.rmdirSync(target);
        }
      } catch (_) {}
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
