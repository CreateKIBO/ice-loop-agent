'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('../node_modules/esbuild');

test('desktop package explicitly includes the static local runtime dependency closure', () => {
  const desktop = path.resolve(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(desktop, 'electron-builder.json'), 'utf8'));
  // Parse real main/preload imports without executing Electron or writing a build.
  const { metafile } = buildSync({
    absWorkingDir: desktop, entryPoints: ['main.cjs', 'preload.cjs'],
    outdir: '__runtime_package_check', bundle: true, platform: 'node',
    external: ['electron'], metafile: true, write: false, logLevel: 'silent',
  });
  const inputs = Object.keys(metafile.inputs).map(name => name.replaceAll('\\', '/'));
  const missing = inputs.filter(name => !config.files.includes(name));
  assert.deepEqual(missing, [], 'Missing runtime files in the desktop package: ' + missing.join(', '));
});
