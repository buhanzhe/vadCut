'use strict';

const fs = require('fs');
const path = require('path');

const { transcribeVideo } = require('../src/asr');

const VIDEO_PATH = (process.argv[2] || '').replace(/^"(.*)"$/, '$1')
  || 'C:\\Users\\bu\\Videos\\语文\\00098.MTS';
const SCHEME_ID = String(process.argv[3] || 'paraformer-bilingual').trim() || 'paraformer-bilingual';

(async () => {
  console.log('=== sherpa-onnx-node Native ASR ===');
  console.log(`视频: ${VIDEO_PATH}\n`);
  console.log(`方案: ${SCHEME_ID}\n`);

  if (!fs.existsSync(VIDEO_PATH)) {
    throw new Error(`视频文件不存在: ${VIDEO_PATH}`);
  }

  const t0 = Date.now();
  const srtPath = await transcribeVideo(VIDEO_PATH, { schemeId: SCHEME_ID }, (msg) => {
    console.log(`[native] ${msg}`);
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (srtPath) {
    console.log(`\n识别完成: ${path.basename(srtPath)} (${elapsed}s)`);
  } else {
    console.log(`\n未生成字幕 (${elapsed}s)`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
