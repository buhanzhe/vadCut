'use strict';

const fs = require('fs');

const { extractAudioToTempWav, safeRemoveFile } = require('../src/audioUtils');
const { detectSpeechBounds } = require('../src/vad');

const VIDEO_PATH = (process.argv[2] || '').replace(/^"(.*)"$/, '$1');

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

(async () => {
  console.log('=== VAD-only 测试（native）===');

  if (!fs.existsSync(VIDEO_PATH)) {
    throw new Error(`视频文件不存在: ${VIDEO_PATH}`);
  }

  console.log('提取 16kHz 音频...');
  const wavPath = await extractAudioToTempWav(VIDEO_PATH);
  try {
    const result = detectSpeechBounds(wavPath);

    console.log(`✓ 音频总时长: ${result.totalDuration.toFixed(1)}s`);
    console.log('── VAD 分段结果 ──────────────────────────────────────');
    result.segments.forEach((seg, index) => {
      const duration = seg.end - seg.start;
      console.log(
        `#${String(index + 1).padStart(2, '0')}  `
        + `[${fmt(seg.start)} → ${fmt(seg.end)}]  ${duration.toFixed(3)}s`
      );
    });
    console.log('─────────────────────────────────────────────────────');
    console.log(`共检测到 ${result.segments.length} 个语音段`);
  } finally {
    safeRemoveFile(wavPath);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
