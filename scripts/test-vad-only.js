'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const { detectSpeechBounds } = require('../src/vad');

const VIDEO_PATH = (process.argv[2] || '').replace(/^"(.*)"$/, '$1')
  || 'C:\\Users\\bu\\Videos\\语文\\00098.MTS';

function extractAudio(videoPath) {
  const tmp = path.join(os.tmpdir(), `vad_test_${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', videoPath,
      '-vn', '-ar', '16000', '-ac', '1',
      '-f', 'wav', '-y', tmp,
    ], { windowsHide: true });
    proc.on('close', (code) => code === 0 ? resolve(tmp) : reject(new Error('ffmpeg failed')));
    proc.on('error', reject);
  });
}

function fmt(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

(async () => {
  console.log('=== VAD-only 测试（native）===');
  console.log(`视频: ${VIDEO_PATH}\n`);

  if (!fs.existsSync(VIDEO_PATH)) {
    throw new Error(`视频文件不存在: ${VIDEO_PATH}`);
  }

  console.log('提取 16kHz 音频...');
  const wav = await extractAudio(VIDEO_PATH);
  try {
    const result = detectSpeechBounds(wav);

    console.log(`✓ 音频总时长: ${result.totalDuration.toFixed(1)}s`);
    console.log(`✓ 语音边界: ${fmt(result.firstSpeechTime)} -> ${fmt(result.lastSpeechTime)}\n`);

    console.log('── VAD 分段结果 ──────────────────────────────────────');
    result.segments.forEach((seg, index) => {
      const dur = seg.end - seg.start;
      console.log(
        `#${String(index + 1).padStart(2, '0')}  ` +
        `[${fmt(seg.start)} → ${fmt(seg.end)}]  ${dur.toFixed(3)}s`
      );
    });
    console.log('─────────────────────────────────────────────────────');
    console.log(`共检测到 ${result.segments.length} 个语音段`);
  } finally {
    try { fs.unlinkSync(wav); } catch (_) {}
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
