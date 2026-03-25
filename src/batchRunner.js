'use strict';

const path = require('path');

function formatElapsed(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}秒`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}分${s}秒`;
}

function buildTimingSummaryLines(timings, totalElapsed) {
  if (!Array.isArray(timings) || timings.length === 0) {
    return [];
  }

  const lines = ['── 耗时汇总 ─────────────────────'];
  for (const timing of timings) {
    lines.push(`  ${timing.name}: ${formatElapsed(timing.elapsed)}`);
  }
  lines.push(`  合计: ${formatElapsed(totalElapsed)}（共 ${timings.length} 个文件）`);
  lines.push('──────────────────────────────────');
  return lines;
}

async function runBatch({
  files,
  concurrency,
  signal = { cancelled: false },
  onFileStart = () => {},
  onFileDone = () => {},
  onFileError = () => {},
  onFileLog = () => {},
  runFile,
}) {
  if (!Array.isArray(files)) {
    throw new TypeError('runBatch files 必须是数组');
  }
  if (typeof runFile !== 'function') {
    throw new TypeError('runBatch 需要 runFile 回调');
  }

  const safeConcurrency = Math.max(1, Math.min(files.length || 1, Number(concurrency) || 1));
  const startedAt = Date.now();
  const results = new Array(files.length);
  const timings = [];
  let success = 0;
  let skipped = 0;
  let errors = 0;
  let running = 0;
  let nextIndex = 0;

  await new Promise((resolveAll) => {
    function maybeResolve() {
      if ((signal.cancelled || nextIndex >= files.length) && running === 0) {
        resolveAll();
      }
    }

    function launchMore() {
      while (running < safeConcurrency && nextIndex < files.length && !signal.cancelled) {
        const index = nextIndex++;
        const filePath = files[index];
        running += 1;
        onFileStart(index, filePath);

        Promise.resolve()
          .then(() => runFile({ index, filePath }))
          .then((result) => {
            results[index] = { ok: true, result };
          })
          .catch((err) => {
            results[index] = { ok: false, err };
          })
          .finally(() => {
            running -= 1;
            const outcome = results[index];

            if (outcome?.ok) {
              const result = outcome.result || {};
              onFileDone(index, result);
              if (result.skipped) {
                skipped += 1;
              } else {
                success += 1;
                if (result.elapsed) {
                  timings.push({
                    name: path.basename(filePath),
                    elapsed: result.elapsed,
                  });
                }
              }
            } else {
              onFileError(index, outcome?.err?.message || '处理失败');
              errors += 1;
            }

            if (signal.cancelled || nextIndex >= files.length) {
              maybeResolve();
            } else {
              launchMore();
            }
          });
      }

      maybeResolve();
    }

    launchMore();
  });

  const totalElapsed = Date.now() - startedAt;
  for (const line of buildTimingSummaryLines(timings, totalElapsed)) {
    onFileLog(-1, line);
  }

  return {
    total: files.length,
    success,
    skipped,
    errors,
    totalElapsed,
    timings,
  };
}

module.exports = {
  buildTimingSummaryLines,
  formatElapsed,
  runBatch,
};
