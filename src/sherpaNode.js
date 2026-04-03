'use strict';

const fs = require('fs');
const path = require('path');

const { getResourcesPath } = require('./runtimePaths');

const SHERPA_VENDOR_SUBPATH = path.join('vendor', 'sherpa-onnx-win-x64', 'sherpa-onnx.node');

let cachedSherpaNode = null;

function appendUniquePath(target, filePath) {
  if (!filePath) return;
  const normalized = path.normalize(filePath);
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function buildSherpaAddonCandidates({
  addonStaticImportPath,
  resourcesPath = '',
  workspaceDir = path.join(__dirname, '..'),
} = {}) {
  const candidates = [];

  if (workspaceDir) {
    appendUniquePath(candidates, path.join(workspaceDir, SHERPA_VENDOR_SUBPATH));
  }

  if (addonStaticImportPath) {
    const addonDir = path.dirname(addonStaticImportPath);
    appendUniquePath(
      candidates,
      path.join(addonDir, '..', '..', SHERPA_VENDOR_SUBPATH)
    );

    if (addonDir.includes('app.asar')) {
      appendUniquePath(
        candidates,
        path.join(addonDir.replace('app.asar', 'app.asar.unpacked'), '..', '..', SHERPA_VENDOR_SUBPATH)
      );
    }
  }

  if (resourcesPath) {
    appendUniquePath(
      candidates,
      path.join(resourcesPath, 'app.asar.unpacked', SHERPA_VENDOR_SUBPATH)
    );
    appendUniquePath(
      candidates,
      path.join(resourcesPath, SHERPA_VENDOR_SUBPATH)
    );
  }

  return candidates;
}

function getSherpaAddonCandidates() {
  let addonStaticImportPath = '';

  try {
    addonStaticImportPath = require.resolve('sherpa-onnx-node/addon-static-import.js');
  } catch (_) {
    addonStaticImportPath = '';
  }

  return buildSherpaAddonCandidates({
    addonStaticImportPath,
    resourcesPath: getResourcesPath() || '',
    workspaceDir: path.join(__dirname, '..'),
  });
}

function preloadBundledSherpaAddon() {
  const addonStaticImportPath = require.resolve('sherpa-onnx-node/addon-static-import.js');

  for (const candidate of getSherpaAddonCandidates()) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const addon = require(candidate);
      require.cache[addonStaticImportPath] = {
        id: addonStaticImportPath,
        filename: addonStaticImportPath,
        loaded: true,
        exports: addon,
      };
      return { addon, candidate };
    } catch (_) {
      //
    }
  }

  return null;
}

function decorateSherpaLoadError(error) {
  if (!error || typeof error !== 'object') {
    return error;
  }

  const candidates = getSherpaAddonCandidates();
  error.message = `${error.message}\nBundled addon candidates:\n  ${candidates.join('\n  ')}`;
  return error;
}

function getSherpaNode() {
  if (cachedSherpaNode) {
    return cachedSherpaNode;
  }

  try {
    preloadBundledSherpaAddon();
    cachedSherpaNode = require('sherpa-onnx-node');
    return cachedSherpaNode;
  } catch (error) {
    throw decorateSherpaLoadError(error);
  }
}

module.exports = {
  SHERPA_VENDOR_SUBPATH,
  buildSherpaAddonCandidates,
  getSherpaAddonCandidates,
  getSherpaNode,
};
