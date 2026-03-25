'use strict';

const fs = require('fs');

const {
  resolveSubtitleSchemeId,
  resolveSubtitleSchemeInfo,
} = require('../src/asrEngine');
const {
  createCancelledError,
  isCancelledError,
} = require('../src/taskCancellation');

const signal = { cancelled: false };
let started = false;
let finished = false;
let transcribeVideoFn = null;

function send(type, payload = {}) {
  if (typeof process.send === 'function' && !finished) {
    process.send({ type, ...payload });
  }
}

function exitSoon(code = 0) {
  finished = true;
  setTimeout(() => process.exit(code), 10);
}

function createStageReporter() {
  let lastStage = '';
  let lastPct = -1;
  let lastSentAt = 0;

  return (stage, pct, force = false) => {
    const normalizedPct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const now = Date.now();
    const pctDelta = Math.abs(normalizedPct - lastPct);
    const shouldSend = force
      || stage !== lastStage
      || pctDelta >= 2
      || (now - lastSentAt) >= 250;

    if (!shouldSend) return;

    lastStage = stage;
    lastPct = normalizedPct;
    lastSentAt = now;
    send(force ? 'stage' : 'progress', {
      stage,
      pct: normalizedPct,
    });
  };
}

function finishWithError(err) {
  if (finished) return;
  if (isCancelledError(err) || signal.cancelled) {
    send('cancelled', {
      message: err?.message || '字幕提取已取消',
    });
    exitSoon(0);
    return;
  }

  send('error', {
    error: err?.message || '字幕提取失败',
  });
  exitSoon(1);
}

function getTranscribeVideo() {
  if (!transcribeVideoFn) {
    ({ transcribeVideo: transcribeVideoFn } = require('../src/asr'));
  }
  return transcribeVideoFn;
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'cancel') {
    signal.cancelled = true;
    return;
  }

  if (message.type !== 'start' || started) {
    return;
  }

  started = true;

  const schemeId = resolveSubtitleSchemeId(message.schemeId);
  const scheme = resolveSubtitleSchemeInfo(schemeId);
  const reportStage = createStageReporter();
  const startedAt = Date.now();

  try {
    if (signal.cancelled) {
      throw createCancelledError('字幕提取已取消');
    }

    const existingSrtPath = String(message.videoPath || '').replace(/\.[^.]+$/, '.srt');
    if (fs.existsSync(existingSrtPath)) {
      send('log', { msg: '已跳过（字幕文件已存在）' });
      send('done', {
        result: {
          skipped: true,
          subtitleOnly: true,
          reason: 'subtitle exists',
          subtitleSchemeId: scheme.schemeId,
          subtitleSchemeLabel: scheme.label,
        },
      });
      exitSoon(0);
      return;
    }

    send('log', { msg: '初始化字幕引擎...' });
    const transcribeVideo = getTranscribeVideo();

    const generatedSrtPath = await transcribeVideo(
      message.videoPath,
      {
        schemeId,
        signal,
        onProgress({ stage, pct, force }) {
          reportStage(stage, pct, force);
        },
      },
      (msg) => {
        send('log', { msg });
      }
    );

    if (signal.cancelled) {
      throw createCancelledError('字幕提取已取消');
    }

    send('done', {
      result: generatedSrtPath
        ? {
          subtitleOnly: true,
          srtPath: generatedSrtPath,
          elapsed: Date.now() - startedAt,
          subtitleSchemeId: scheme.schemeId,
          subtitleSchemeLabel: scheme.label,
        }
        : {
          skipped: true,
          subtitleOnly: true,
          reason: 'empty subtitle',
          elapsed: Date.now() - startedAt,
          subtitleSchemeId: scheme.schemeId,
          subtitleSchemeLabel: scheme.label,
        },
    });
    exitSoon(0);
  } catch (err) {
    finishWithError(err);
  }
});

process.on('disconnect', () => {
  signal.cancelled = true;
});

process.on('uncaughtException', (err) => {
  finishWithError(err);
});

process.on('unhandledRejection', (err) => {
  finishWithError(err instanceof Error ? err : new Error(String(err)));
});

send('ready');
