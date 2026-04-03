'use strict';

const fs = require('fs');

const { getSherpaAddonCandidates } = require('../src/sherpaNode');

const addonPath = getSherpaAddonCandidates().find((candidate) => fs.existsSync(candidate));

if (!addonPath) {
  console.error('FAIL: no bundled sherpa addon candidate exists');
  for (const candidate of getSherpaAddonCandidates()) {
    console.error(`  ${candidate}`);
  }
  process.exit(1);
}

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
