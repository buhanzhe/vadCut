#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const { MODEL_DOWNLOAD_SOURCES } = require('../src/asrEngine');

const MODELSCOPE_API_BASE_URL = 'https://modelscope.cn/api/v1/models';
const MODELSCOPE_REVISION = 'master';
const DEST_ROOT = path.join(__dirname, '..', 'models');

function encodeRepoPath(filePath) {
  return encodeURIComponent(filePath);
}

function buildDownloadUrl(source, filePath) {
  return `${MODELSCOPE_API_BASE_URL}/${source.repoId}/repo?Revision=${MODELSCOPE_REVISION}&FilePath=${encodeRepoPath(filePath)}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)}${units[idx]}`;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const req = https.get({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers: {
        'User-Agent': 'vad-cut-model-downloader/1.0',
        Accept: '*/*',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if (statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => reject(new Error(`HTTP ${statusCode}: ${body.slice(0, 160)}`)));
        return;
      }

      const totalBytes = Number(res.headers['content-length'] || 0);
      let downloadedBytes = 0;
      const tmpPath = `${dest}.download`;
      const output = fs.createWriteStream(tmpPath);

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      res.on('error', reject);
      output.on('error', reject);

      output.on('finish', () => {
        output.close(() => {
          fs.renameSync(tmpPath, dest);
          resolve();
        });
      });

      res.pipe(output);
    });

    req.on('error', reject);
  });
}

async function downloadSource(source) {
  const targetDir = path.join(DEST_ROOT, source.modelDir);
  ensureDir(targetDir);

  console.log(`\n== ${source.label} ==`);
  console.log(`源: ${source.sourceUrl}`);
  console.log(`目录: ${targetDir}`);

  for (const file of source.requiredFiles.filter((item) => item.required !== false)) {
    const dest = path.join(targetDir, file.path);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`跳过已存在文件: ${file.path}`);
      continue;
    }

    ensureDir(path.dirname(dest));
    const url = buildDownloadUrl(source, file.path);
    process.stdout.write(`下载 ${file.path} ... 0%`);
    await downloadFile(url, dest, (downloadedBytes, totalBytes) => {
      const percent = totalBytes > 0
        ? `${Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))}%`
        : formatBytes(downloadedBytes);
      process.stdout.write(`\r下载 ${file.path} ... ${percent}`);
    });
    process.stdout.write('\n');
  }
}

async function main() {
  const requestedIds = process.argv.slice(2);
  const targets = requestedIds.length === 0
    ? MODEL_DOWNLOAD_SOURCES
    : MODEL_DOWNLOAD_SOURCES.filter((source) => requestedIds.includes(source.sourceId));

  if (targets.length === 0) {
    console.error('未匹配到可下载模型。可用 sourceId:');
    for (const source of MODEL_DOWNLOAD_SOURCES) {
      console.error(`- ${source.sourceId}`);
    }
    process.exit(1);
  }

  ensureDir(DEST_ROOT);
  for (const source of targets) {
    await downloadSource(source);
  }

  console.log('\n全部下载任务完成。');
}

main().catch((err) => {
  console.error('\n下载失败:', err.message);
  process.exit(1);
});
