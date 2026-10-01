// Offline extraction of the official archive; checksum is mandatory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const zip = process.argv[2] || path.join(root, '.electron-cache', 'electron-v44.5.1-win32-x64.zip');
const expected = require('../node_modules/electron/checksums.json')['electron-v44.5.1-win32-x64.zip'];
const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (hash !== expected) throw Error('Electron checksum mismatch; archive was not extracted');
require('../node_modules/@electron-internal/extract-zip').extract(zip, {dir:path.join(root, 'node_modules', 'electron', 'dist')})
  .then(() => { fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe'); console.log('Official SHA256 verified; Electron installed'); })
  .catch(error => { console.error(error); process.exitCode = 1; });
