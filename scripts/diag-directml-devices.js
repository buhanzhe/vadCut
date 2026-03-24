'use strict';

const path = require('path');
const { spawn } = require('child_process');

const maxDeviceId = Number(process.argv[2] || 3);
const debug = Number(process.env.ASR_DIRECTML_DEBUG || 0);
const provider = process.env.ASR_PROVIDER || 'directml';
const workerPath = path.join(__dirname, 'diag-directml-device-worker.js');

function probeDevice(device) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [workerPath], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        SHERPA_ONNX_DIRECTML_DEVICE: String(device),
        ASR_PROVIDER: provider,
        ASR_DIRECTML_DEBUG: String(debug),
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (error) => {
      resolve({
        device,
        ok: false,
        exitCode: null,
        signal: null,
        error: error && error.message ? error.message : String(error),
        stdout,
        stderr,
      });
    });
    proc.on('close', (code, signal) => {
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (code === 0 && parsed.ok) {
          resolve({
            device,
            ok: true,
            exitCode: code,
            signal,
            stdout,
            stderr,
          });
          return;
        }
      } catch (_) {}

      resolve({
        device,
        ok: false,
        exitCode: code,
        signal,
        error: stderr.trim() || stdout.trim() || `exit=${code}`,
        stdout,
        stderr,
      });
    });
  });
}

(async () => {
  for (let device = 0; device <= maxDeviceId; device++) {
    const result = await probeDevice(device);
    if (result.ok) {
      console.log(`${provider} device ${device}: OK`);
      if (result.stderr.trim()) {
        console.log(result.stderr.trim());
      }
    } else {
      console.log(`${provider} device ${device}: FAIL`);
      console.log(result.error);
      if (result.exitCode !== null) {
        console.log(`exitCode=${result.exitCode}`);
      }
      if (result.signal) {
        console.log(`signal=${result.signal}`);
      }
    }
  }
})().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
