'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDownloadProgressTracker } = require('../src/asrEngine');

test('accumulates total bytes across multiple unknown-size files', () => {
  const files = [
    { path: 'encoder.onnx' },
    { path: 'decoder.onnx' },
    { path: 'tokens.txt' },
  ];
  const tracker = createDownloadProgressTracker(files);

  assert.deepEqual(tracker.getProgress(0), {
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
  });

  tracker.observeFileTotal(files[0], 120);
  assert.deepEqual(tracker.getProgress(60), {
    downloadedBytes: 60,
    totalBytes: 120,
    percent: 50,
  });

  tracker.observeFileTotal(files[1], 240);
  assert.deepEqual(tracker.getProgress(180), {
    downloadedBytes: 180,
    totalBytes: 360,
    percent: 50,
  });

  tracker.observeFileTotal(files[2], 40);
  assert.deepEqual(tracker.getProgress(360), {
    downloadedBytes: 360,
    totalBytes: 400,
    percent: 90,
  });
});

test('adds discovered unknown-size files on top of known expected totals', () => {
  const files = [
    { path: 'model.int8.onnx', expectedSize: 300 },
    { path: 'model.onnx', expectedSize: 700 },
    { path: 'tokens.txt' },
  ];
  const tracker = createDownloadProgressTracker(files);

  assert.deepEqual(tracker.getProgress(0), {
    downloadedBytes: 0,
    totalBytes: 1000,
    percent: 0,
  });

  tracker.observeFileTotal(files[2], 25);
  assert.deepEqual(tracker.getProgress(1010), {
    downloadedBytes: 1010,
    totalBytes: 1025,
    percent: 99,
  });
});
