'use strict';

const VALID_ASR_PROVIDERS = new Set(['cpu', 'directml']);
const requestedProvider = String(process.env.VADCUT_ASR_PROVIDER || 'cpu').trim().toLowerCase();
const PREFERRED_ASR_PROVIDER = VALID_ASR_PROVIDERS.has(requestedProvider)
  ? requestedProvider
  : 'cpu';
const ASR_PROVIDER_FALLBACKS = PREFERRED_ASR_PROVIDER === 'directml'
  ? ['cpu']
  : ['directml'];

module.exports = {
  VALID_ASR_PROVIDERS,
  PREFERRED_ASR_PROVIDER,
  ASR_PROVIDER_FALLBACKS,
};
