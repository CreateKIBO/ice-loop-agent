'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { UI_PAGES, CLASSIC_SMOKE_FLAGS, readUiMode, writeUiMode, chooseStartPage } = require('../ui-mode.cjs');

const desktop = path.resolve(__dirname, '..');
const scratch = path.join(desktop, '..', '.test-tmp', 'ui-mode-test');
const start = (argv, overrides = {}) => chooseStartPage({ argv, newUiBuilt: true, savedMode: 'new', ...overrides });

test('new workbench is the default; a saved classic choice is honoured', () => {
  assert.equal(start([]), UI_PAGES.new);
  assert.equal(start([], { savedMode: 'classic' }), UI_PAGES.classic);
  assert.equal(start(['--new-ui'], { savedMode: 'classic' }), UI_PAGES.new);
  assert.equal(start(['--classic-ui']), UI_PAGES.classic);
});

test('a missing new-UI build always falls back to the classic page', () => {
  assert.equal(start([], { newUiBuilt: false }), UI_PAGES.classic);
  assert.equal(start(['--new-ui'], { newUiBuilt: false }), UI_PAGES.classic);
});

test('smokes that drive classic-page hooks never land on the new workbench', () => {
  for (const flag of CLASSIC_SMOKE_FLAGS) assert.equal(start([flag]), UI_PAGES.classic, flag);
  assert.equal(start(['--ui-smoke'], { savedMode: 'classic' }), UI_PAGES.new);
  assert.equal(start(['--dpi-smoke', '--new-ui'], { savedMode: 'classic' }), UI_PAGES.new);
});

test('both pages are trusted app frames in main.cjs', () => {
  const main = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
  for (const page of Object.values(UI_PAGES)) assert.ok(main.includes(`'${page}'`), page);
});

test('preference file round-trips and treats missing or corrupt files as the default', () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  try {
    const file = path.join(scratch, 'ui-preference.json');
    assert.equal(readUiMode(file), 'new');
    writeUiMode(file, 'classic');
    assert.equal(readUiMode(file), 'classic');
    assert.equal(fs.existsSync(file + '.tmp'), false);
    writeUiMode(file, 'new');
    assert.equal(readUiMode(file), 'new');
    fs.writeFileSync(file, '{not json');
    assert.equal(readUiMode(file), 'new');
    assert.throws(() => writeUiMode(file, 'legacy'), /未知界面/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
