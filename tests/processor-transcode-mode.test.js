'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadProcessorWithMocks(overrides = {}) {
  const processorPath = require.resolve('../src/processor');
  const originalProcessor = require.cache[processorPath];
  const originals = new Map();

  for (const [request, exports] of Object.entries(overrides)) {
    const resolved = require.resolve(request);
    originals.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }

  delete require.cache[processorPath];
  const processor = require('../src/processor');

  return {
    processor,
    restore() {
      delete require.cache[processorPath];
      if (originalProcessor) {
        require.cache[processorPath] = originalProcessor;
      }

      for (const [resolved, original] of originals) {
        if (original) {
          require.cache[resolved] = original;
        } else {
          delete require.cache[resolved];
        }
      }
    },
  };
}

test('processVideo transcodeOnly forwards duration and audio presence to ffmpeg layer', async (t) => {
  const calls = [];
  const logs = [];
  const stages = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vadcut-transcode-video-'));
  const outputDir = path.join(tempRoot, '转码');
  const videoPath = path.join(tempRoot, 'lesson.mkv');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(videoPath, '');

  const { processor, restore } = loadProcessorWithMocks({
    '../src/ffmpegUtils': {
      getVideoMetadata: async () => ({
        format: { duration: 32.5 },
        streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
      }),
      trimVideo: async () => {
        throw new Error('trimVideo should not be called in transcodeOnly mode');
      },
      transcodeVideo: async (...args) => {
        calls.push(args);
      },
      getEncoderInfo: async () => 'CPU (libx264)',
    },
    '../src/asr': {
      transcribeVideo: async () => {
        throw new Error('transcribeVideo should not be called in transcodeOnly mode');
      },
    },
    '../src/asrEngine': {
      resolveSubtitleSchemeInfo: () => ({ schemeId: 'stub', label: 'Stub' }),
    },
  });

  t.after(() => {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const result = await processor.processVideo(
    videoPath,
    outputDir,
    {
      onLog: (msg) => logs.push(msg),
      onStage: (stage, pct) => stages.push([stage, pct]),
    },
    { transcodeOnly: true, signal: { cancelled: false } }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], videoPath);
  assert.equal(calls[0][1], path.join(outputDir, 'lesson.mp4'));
  assert.equal(calls[0][2], 32.5);
  assert.deepEqual(calls[0][4], {
    signal: { cancelled: false },
    hasAudio: true,
  });

  assert.equal(result.transcodeOnly, true);
  assert.equal(result.outputPath, path.join(outputDir, 'lesson.mp4'));
  assert.ok(result.elapsed >= 0);
  assert.ok(logs.includes('转码中...'));
  assert.deepEqual(stages, [
    ['metadata', 0],
    ['metadata', 100],
    ['transcode', 0],
    ['transcode', 100],
  ]);
});

test('processFolder transcodeOnly uses 转码 output directory and logs mode', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vadcut-transcode-folder-'));
  const videoA = path.join(tempRoot, 'a.mp4');
  const videoB = path.join(tempRoot, 'b.mov');
  const onFileLogMessages = [];
  let summary = null;

  fs.writeFileSync(videoA, '');
  fs.writeFileSync(videoB, '');

  const { processor, restore } = loadProcessorWithMocks({
    '../src/ffmpegUtils': {
      getVideoMetadata: async () => ({
        format: { duration: 12 },
        streams: [{ codec_type: 'video' }],
      }),
      trimVideo: async () => {
        throw new Error('trimVideo should not be called in transcodeOnly mode');
      },
      transcodeVideo: async () => {},
      getEncoderInfo: async () => 'CPU (libx264)',
    },
    '../src/asr': {
      transcribeVideo: async () => {
        throw new Error('transcribeVideo should not be called in transcodeOnly mode');
      },
    },
    '../src/asrEngine': {
      resolveSubtitleSchemeInfo: () => ({ schemeId: 'stub', label: 'Stub' }),
    },
  });

  t.after(() => {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await processor.processFolder(
    tempRoot,
    {
      onFileLog: (_index, msg) => onFileLogMessages.push(msg),
      onAllDone: (payload) => {
        summary = payload;
      },
    },
    { cancelled: false },
    { transcodeOnly: true }
  );

  assert.ok(summary);
  assert.equal(summary.success, 2);
  assert.equal(summary.errors, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.outputDir, path.join(tempRoot, '转码'));
  assert.ok(fs.existsSync(summary.outputDir));
  assert.ok(onFileLogMessages.includes('模式: 仅转码'));
});
