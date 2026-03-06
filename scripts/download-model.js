#!/usr/bin/env node
/**
 * 下载 silero_vad.onnx 模型文件到 models/ 目录
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const MODEL_DIR = path.join(__dirname, '..', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'silero_vad.onnx');

if (!fs.existsSync(MODEL_DIR)) {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
}

if (fs.existsSync(MODEL_PATH)) {
  console.log('✓ 模型文件已存在:', MODEL_PATH);
  process.exit(0);
}

console.log('正在下载 silero_vad.onnx 模型...');
console.log('URL:', MODEL_URL);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        console.log('重定向到:', response.headers.location);
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`下载失败，HTTP 状态码: ${response.statusCode}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          process.stdout.write(`\r下载进度: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB)`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log('\n✓ 下载完成:', dest);
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });

    file.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

download(MODEL_URL, MODEL_PATH)
  .then(() => {
    const stat = fs.statSync(MODEL_PATH);
    console.log(`模型文件大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
    console.log('\n环境准备完成！可以运行程序了。');
  })
  .catch((err) => {
    console.error('下载失败:', err.message);
    console.error('\n请手动下载模型文件:');
    console.error('URL:', MODEL_URL);
    console.error('保存到:', MODEL_PATH);
    process.exit(1);
  });
