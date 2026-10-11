'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const desktop = path.resolve(__dirname, '..');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(desktop, 'ui/src/app/paneLayout.ts'), 'utf8'),
  { loader: 'ts', format: 'cjs' }).code, sandbox);
const { fitSizes, resizePane, normalizeSizes, PANE_DEFAULTS } = sandbox.module.exports;

// 对象在 vm 沙箱里创建，原型不同；转成本 realm 的普通对象再比较。
const plain = sizes => ({ left: sizes.left, right: sizes.right });
const center = (sizes, width) => width - 10 - sizes.left - sizes.right;

test('wide windows keep the preferred widths untouched', () => {
  assert.deepEqual(plain(fitSizes({ left: 260, right: 380 }, 1446)), { left: 260, right: 380 });
  assert.deepEqual(plain(fitSizes({ left: 260, right: 380 }, 0)), { left: 260, right: 380 });
});

test('medium windows give the writing pane a comfortable width before squeezing to hard minimums', () => {
  const sizes = fitSizes({ left: 260, right: 380 }, 1000);
  assert.deepEqual(plain(sizes), { left: 230, right: 280 });
  assert.equal(center(sizes, 1000), 480);
});

test('narrow windows fall back to the hard minimum centre and never go below the hard pane minimums', () => {
  const sizes = fitSizes({ left: 260, right: 380 }, 723);
  assert.equal(center(sizes, 723), 320);
  assert.ok(sizes.left >= 160 && sizes.right >= 220);
  const tiny = fitSizes({ left: 260, right: 380 }, 500);
  assert.deepEqual(plain(tiny), { left: 160, right: 220 });
});

test('stored sizes are clamped and invalid values fall back to defaults', () => {
  assert.deepEqual(plain(normalizeSizes({ left: 9999, right: 1 })), { left: 480, right: 280 });
  assert.deepEqual(plain(normalizeSizes({ left: 'x', right: undefined })), plain(PANE_DEFAULTS));
});

test('dragging stops where fitSizes would start squeezing, so the divider never drifts from the pane', () => {
  const width = 1200;
  let preferred = { left: 260, right: 380 };
  for (let step = 0; step < 20; step += 1) preferred = resizePane(preferred, 'left', 64, width);
  const sizes = fitSizes(preferred, width);
  assert.equal(sizes.left, preferred.left, 'the stored preference is what the user sees');
  assert.equal(center(sizes, width), 480);
});

test('dragging one side keeps the other side preference even while it is squeezed', () => {
  const preferred = resizePane({ left: 260, right: 600 }, 'left', -20, 1000);
  assert.equal(preferred.right, 600);
  assert.equal(preferred.left, 210);
});
