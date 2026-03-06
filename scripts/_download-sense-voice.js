const https = require('https');
const http = require('http');
const fs = require('fs');

const dest = 'models/sense-voice.tar.bz2';
const url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.28/sherpa-onnx-wasm-simd-1.12.28-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small.tar.bz2';

fs.mkdirSync('models', { recursive: true });

let file = fs.createWriteStream(dest);

function req(u, depth) {
  if (depth > 10) { console.error('too many redirects'); process.exit(1); }
  const mod = u.startsWith('https') ? https : http;
  mod.get(u, (res) => {
    if ([301, 302, 303].includes(res.statusCode)) {
      res.resume();
      file.destroy();
      file = fs.createWriteStream(dest);
      return req(res.headers.location, depth + 1);
    }
    if (res.statusCode !== 200) {
      console.error('HTTP', res.statusCode, u);
      process.exit(1);
    }
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let got = 0;
    res.on('data', (c) => {
      got += c.length;
      if (total) {
        process.stdout.write('\r  ' + (got / 1024 / 1024).toFixed(1) + ' / ' + (total / 1024 / 1024).toFixed(1) + ' MB (' + (got / total * 100).toFixed(0) + '%)   ');
      }
    });
    res.pipe(file);
    file.on('finish', () => { file.close(); console.log('\n下载完成: ' + dest); });
    file.on('error', (e) => { console.error(e.message); process.exit(1); });
  }).on('error', (e) => { console.error(e.message); process.exit(1); });
}

req(url, 0);
