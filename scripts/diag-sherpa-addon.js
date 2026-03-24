'use strict';

const path = require('path');

const addonPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'sherpa-onnx-win-x64',
  'sherpa-onnx.node'
);

try {
  require(addonPath);
  console.log(`OK ${addonPath}`);
} catch (error) {
  console.error(`FAIL ${addonPath}`);
  console.error(error && error.message ? error.message : String(error));
  if (error && error.code) {
    console.error(`code=${error.code}`);
  }
  if (error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
