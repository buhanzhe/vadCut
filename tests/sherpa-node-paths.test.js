'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildSherpaAddonCandidates } = require('../src/sherpaNode');

test('buildSherpaAddonCandidates includes app.asar.unpacked vendor path for packaged builds', () => {
  const resourcesPath = path.join(
    'C:\\',
    'Users',
    'Administrator',
    'AppData',
    'Local',
    'Programs',
    'VAD-Cut',
    'resources'
  );
  const addonStaticImportPath = path.join(
    resourcesPath,
    'app.asar',
    'node_modules',
    'sherpa-onnx-node',
    'addon-static-import.js'
  );
  const workspaceDir = path.join('C:\\', 'nodeWorkspace', 'vadCut');

  const candidates = buildSherpaAddonCandidates({
    addonStaticImportPath,
    resourcesPath,
    workspaceDir,
  });

  assert.ok(candidates.includes(
    path.join(resourcesPath, 'app.asar.unpacked', 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
  ));
  assert.ok(candidates.includes(
    path.join(workspaceDir, 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
  ));
});

test('buildSherpaAddonCandidates keeps local vendor path for development runs', () => {
  const projectRoot = path.join('C:\\', 'nodeWorkspace', 'vadCut');
  const addonStaticImportPath = path.join(
    projectRoot,
    'node_modules',
    'sherpa-onnx-node',
    'addon-static-import.js'
  );

  const candidates = buildSherpaAddonCandidates({
    addonStaticImportPath,
    resourcesPath: '',
    workspaceDir: projectRoot,
  });

  assert.ok(candidates.includes(
    path.join(projectRoot, 'vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
  ));
});
