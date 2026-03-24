'use strict';

const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = new Set(['zh-CN.pak']);

function pruneLocales(appOutDir) {
  const localesDir = path.join(appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) {
    console.log(`[prune-electron-locales] skip: locales dir not found at ${localesDir}`);
    return;
  }

  const entries = fs.readdirSync(localesDir, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (KEEP_LOCALES.has(entry.name)) continue;

    fs.rmSync(path.join(localesDir, entry.name), { force: true });
    removed += 1;
  }

  console.log(
    `[prune-electron-locales] kept ${Array.from(KEEP_LOCALES).join(', ')}; removed ${removed} locale files`
  );
}

module.exports = async function afterPack(context) {
  pruneLocales(context.appOutDir);
};

if (require.main === module) {
  const appOutDir = process.argv[2];
  if (!appOutDir) {
    throw new Error('Usage: node scripts/prune-electron-locales.js <appOutDir>');
  }
  pruneLocales(path.resolve(appOutDir));
}
