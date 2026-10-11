'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const desktop = path.resolve(__dirname, '..');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(desktop, 'ui/src/features/editor/inlineDiff.ts'), 'utf8'),
  { loader: 'ts', format: 'cjs' }).code, sandbox);
const { inlineDiff } = sandbox.module.exports;

const join = parts => parts.map(part => part.text).join('');
// Array.from 在本 realm 创建数组：vm 沙箱里的数组原型不同，deepStrictEqual 会判不等。
const kinds = parts => Array.from(parts, part => part.kind + ':' + part.text);

test('both sides reconstruct their original text exactly', () => {
  for (const [before, after] of [
    ['for 循环把一串东西挨个取出来。', 'for 循环会把序列里的元素挨个取出来。'],
    ['', '新增的一整段'],
    ['被删除的一整段', ''],
    ['完全一样', '完全一样'],
    ['emoji 👍 保持', 'emoji 👎 保持'],
  ]) {
    const diff = inlineDiff(before, after);
    assert.equal(join(diff.before), before);
    assert.equal(join(diff.after), after);
    assert.ok(diff.before.every(part => part.kind !== 'add'));
    assert.ok(diff.after.every(part => part.kind !== 'del'));
  }
});

test('marks only the changed middle and keeps shared prefix and suffix', () => {
  const diff = inlineDiff('今天学习 for 循环。', '今天学习 while 循环。');
  assert.deepEqual(kinds(diff.before), ['same:今天学习 ', 'del:for', 'same: 循环。']);
  assert.deepEqual(kinds(diff.after), ['same:今天学习 ', 'add:while', 'same: 循环。']);
});

test('identical text has no highlighted parts', () => {
  const diff = inlineDiff('一样的内容', '一样的内容');
  assert.deepEqual(kinds(diff.before), ['same:一样的内容']);
  assert.deepEqual(kinds(diff.after), ['same:一样的内容']);
});

test('short shared characters between edits are glued into one change', () => {
  // "的" 同时出现在两边，但单独保留它会把一处改写切成碎片
  const diff = inlineDiff('甲的乙', '丙的丁');
  assert.deepEqual(kinds(diff.before), ['del:甲的乙']);
  assert.deepEqual(kinds(diff.after), ['add:丙的丁']);
});

test('does not split surrogate pairs', () => {
  const diff = inlineDiff('a👍b', 'a👎b');
  assert.deepEqual(kinds(diff.before), ['same:a', 'del:👍', 'same:b']);
  assert.deepEqual(kinds(diff.after), ['same:a', 'add:👎', 'same:b']);
});

test('very long rewrites fall back to whole-block replacement without hanging', () => {
  const before = 'x' + '甲'.repeat(2000) + 'y';
  const after = 'x' + '乙'.repeat(2000) + 'y';
  const started = Date.now();
  const diff = inlineDiff(before, after);
  assert.ok(Date.now() - started < 2000);
  assert.equal(diff.truncated, true);
  assert.equal(join(diff.before), before);
  assert.equal(join(diff.after), after);
});
