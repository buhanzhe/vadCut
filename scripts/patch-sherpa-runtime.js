'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const vendorDir = path.join(projectRoot, 'vendor', 'sherpa-onnx-win-x64');
const runtimePackageDir = path.join(projectRoot, 'node_modules', 'sherpa-onnx-win-x64');
const wrapperDir = path.join(projectRoot, 'node_modules', 'sherpa-onnx-node');
const addonStaticImportPath = path.join(wrapperDir, 'addon-static-import.js');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('[patch-sherpa-runtime] skip: only needed on win32 x64');
  process.exit(0);
}

if (!fs.existsSync(vendorDir)) {
  console.log('[patch-sherpa-runtime] skip: vendor runtime not found');
  process.exit(0);
}

if (!fs.existsSync(wrapperDir)) {
  console.log('[patch-sherpa-runtime] skip: sherpa-onnx-node not installed');
  process.exit(0);
}

const patchedAddonStaticImport = `'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let addon = null;

const platform = os.platform() === 'win32' ? 'win' : os.platform();
const arch = os.arch();

function appendUniquePath(target, filePath) {
  if (!filePath) return;
  const normalized = path.normalize(filePath);
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function getAddonCandidates() {
  const candidates = [];
  if (platform === 'win' && arch === 'x64') {
    appendUniquePath(candidates, path.join(__dirname, '..', '..', 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'));

    if (__dirname.includes('app.asar')) {
      appendUniquePath(
        candidates,
        path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), '..', '..', 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
      );
    }

    if (process.resourcesPath) {
      appendUniquePath(
        candidates,
        path.join(process.resourcesPath, 'app.asar.unpacked', 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
      );
      appendUniquePath(
        candidates,
        path.join(process.resourcesPath, 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
      );
    }
  }
  return candidates;
}

for (const candidate of getAddonCandidates()) {
  try {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    addon = require(candidate);
    break;
  } catch (error) {
    //
  }
}

module.exports = addon;
`;

fs.writeFileSync(addonStaticImportPath, patchedAddonStaticImport, 'utf8');

if (fs.existsSync(runtimePackageDir)) {
  try {
    fs.rmSync(runtimePackageDir, { recursive: true, force: true });
    console.log('[patch-sherpa-runtime] removed duplicate node_modules/sherpa-onnx-win-x64');
  } catch (error) {
    console.log(`[patch-sherpa-runtime] warn: could not remove duplicate node_modules runtime (${error.code || error.message})`);
  }
}

console.log('[patch-sherpa-runtime] sherpa-onnx-node now loads native runtime from vendor/sherpa-onnx-win-x64');
