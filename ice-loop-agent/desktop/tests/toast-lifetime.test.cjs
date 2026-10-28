'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('../ui/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../ui/src/components/toastLifetime.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} }; new Function('module', 'exports', code)(loaded, loaded.exports);
const { ToastLifetime } = loaded.exports;

test('reading time survives pause, host transfer and a fresh card resuming it', () => {
  let now = 0; const lifetime = new ToastLifetime(4000, () => now);
  assert.equal(lifetime.resume(), 4000); now = 1700; lifetime.pause();
  now = 5000; assert.equal(lifetime.remaining(), 2300);
  assert.equal(lifetime.resume(), 2300); now = 5400; lifetime.pause();
  now = 8000; assert.equal(lifetime.resume(), 1900); now = 9900;
  assert.equal(lifetime.remaining(), 0);
});
test('StrictMode cleanup and repeated resume cannot reset or double-charge elapsed time', () => {
  let now = 0; const lifetime = new ToastLifetime(1200, () => now);
  lifetime.resume(); lifetime.pause(); lifetime.resume();
  now = 100; assert.equal(lifetime.resume(), 1100);
  now = 300; lifetime.pause(); lifetime.pause(); assert.equal(lifetime.remaining(), 900);
});
test('a running clock can be sampled for a new progress element before old-card cleanup', () => {
  let now = 0; const lifetime = new ToastLifetime(4000, () => now);
  lifetime.resume(); now = 1800; assert.equal(lifetime.remaining(), 2200);
  now = 1810; lifetime.pause(); now = 1815; assert.equal(lifetime.resume(), 2190);
});
test('an exhausted notification cannot gain time when resumed by a new host', () => {
  let now = 0; const lifetime = new ToastLifetime(100, () => now);
  lifetime.resume(); now = 1000; assert.equal(lifetime.remaining(), 0);
  lifetime.pause(); now = 2000; assert.equal(lifetime.resume(), 0);
  now = 3000; lifetime.pause(); assert.equal(lifetime.remaining(), 0);
});
