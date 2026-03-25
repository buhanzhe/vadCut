'use strict';

const { spawn } = require('child_process');

const { createCancelledError } = require('./taskCancellation');

function resolveUnpacked(filePath) {
  return filePath.replace('app.asar', 'app.asar.unpacked');
}

const ffmpegPath = resolveUnpacked(require('ffmpeg-static'));

function appendLimited(text, chunk, limit = 32768) {
  const next = text + chunk.toString();
  return next.length > limit ? next.slice(-limit) : next;
}

function parseTimestampToSeconds(value) {
  if (!value || typeof value !== 'string') return 0;
  const match = value.trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function runFfmpeg(args, { signal = null, onProgress = null, durationSec = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const wantsProgress = typeof onProgress === 'function' && Number.isFinite(durationSec) && durationSec > 0;
    const commandArgs = wantsProgress
      ? ['-progress', 'pipe:1', '-nostats', ...args]
      : [...args];
    const proc = spawn(ffmpegPath, commandArgs, { windowsHide: true });

    let stderr = '';
    let progressBuffer = '';
    let settled = false;
    let lastPct = -1;

    const cancelWatcher = signal
      ? setInterval(() => {
        if (signal.cancelled && !proc.killed) {
          try {
            proc.kill();
          } catch (_) {}
        }
      }, 100)
      : null;

    function cleanup() {
      if (cancelWatcher) {
        clearInterval(cancelWatcher);
      }
    }

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    function emitProgress(seconds, force = false) {
      if (!wantsProgress) return;
      const pct = force
        ? 100
        : Math.max(0, Math.min(99, Math.round((seconds / durationSec) * 100)));
      if (!force && pct === lastPct) return;
      lastPct = pct;
      onProgress(pct);
    }

    function handleProgressLine(line) {
      const sep = line.indexOf('=');
      if (sep <= 0) return;
      const key = line.slice(0, sep);
      const value = line.slice(sep + 1).trim();

      if (key === 'out_time_ms') {
        const seconds = Number(value) / 1000000;
        if (Number.isFinite(seconds)) {
          emitProgress(seconds);
        }
        return;
      }

      if (key === 'out_time_us') {
        const seconds = Number(value) / 1000000;
        if (Number.isFinite(seconds)) {
          emitProgress(seconds);
        }
        return;
      }

      if (key === 'out_time') {
        emitProgress(parseTimestampToSeconds(value));
        return;
      }

      if (key === 'progress' && value === 'end') {
        emitProgress(durationSec, true);
      }
    }

    function flushProgressBuffer(flushRemainder = false) {
      let newlineIndex = progressBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = progressBuffer.slice(0, newlineIndex).trim();
        progressBuffer = progressBuffer.slice(newlineIndex + 1);
        handleProgressLine(line);
        newlineIndex = progressBuffer.indexOf('\n');
      }

      if (flushRemainder && progressBuffer.trim()) {
        handleProgressLine(progressBuffer.trim());
        progressBuffer = '';
      }
    }

    proc.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    if (wantsProgress) {
      proc.stdout.on('data', (chunk) => {
        progressBuffer += chunk.toString();
        flushProgressBuffer(false);
      });
    }

    proc.on('error', (err) => {
      if (signal?.cancelled) {
        finish(reject, createCancelledError('任务已取消'));
        return;
      }
      finish(reject, err);
    });

    proc.on('close', (code) => {
      flushProgressBuffer(true);

      if (code === 0) {
        emitProgress(durationSec, true);
        finish(resolve, { stderr });
        return;
      }

      if (signal?.cancelled) {
        finish(reject, createCancelledError('任务已取消'));
        return;
      }

      const detail = stderr.trim();
      finish(
        reject,
        new Error(detail ? `ffmpeg 执行失败（code=${code}）: ${detail}` : `ffmpeg 执行失败（code=${code}）`)
      );
    });
  });
}

module.exports = {
  ffmpegPath,
  resolveUnpacked,
  runFfmpeg,
};
