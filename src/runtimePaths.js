'use strict';

const os = require('os');
const path = require('path');

const electronApp = (() => {
  try {
    return require('electron')?.app || null;
  } catch {
    return null;
  }
})();

function isPackagedRuntime() {
  if (process.env.VADCUT_APP_PACKAGED === '1') {
    return true;
  }
  return Boolean(electronApp && electronApp.isPackaged);
}

function getResourcesPath() {
  if (process.env.VADCUT_RESOURCES_PATH) {
    return process.env.VADCUT_RESOURCES_PATH;
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    return process.resourcesPath;
  }
  return null;
}

function getUserDataPath() {
  if (process.env.VADCUT_USER_DATA_PATH) {
    return process.env.VADCUT_USER_DATA_PATH;
  }
  if (electronApp && typeof electronApp.getPath === 'function') {
    return electronApp.getPath('userData');
  }
  return null;
}

function getHomeDir() {
  if (electronApp && typeof electronApp.getPath === 'function') {
    return electronApp.getPath('home');
  }
  return os.homedir();
}

function resolveBundledModelsRoot(fallbackDirname) {
  const resourcesPath = getResourcesPath();
  if (isPackagedRuntime() && resourcesPath) {
    return path.join(resourcesPath, 'models');
  }
  return path.join(fallbackDirname, '..', 'models');
}

module.exports = {
  electronApp,
  getHomeDir,
  getResourcesPath,
  getUserDataPath,
  isPackagedRuntime,
  resolveBundledModelsRoot,
};
