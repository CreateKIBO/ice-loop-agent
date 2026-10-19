'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { ExportApprovals } = require('../export-approval.cjs');
const desktop = path.resolve(__dirname, '..');
const sandbox = { module:{exports:{}}, exports:{} };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(desktop,'ui/src/data/dirtyFlush.ts'),'utf8'),
  {loader:'ts', format:'cjs'}).code, sandbox);
const { createDirtyFlusher } = sandbox.module.exports;

test('failed recovery write blocks navigation; successful retry clears failure', async () => {
  const flush = createDirtyFlusher(() => true);
  let fail = true, navigated = false;
  flush.registerDirtyFlush('article-1', () => { if(fail) throw Error('disk full'); });
  await assert.rejects(async () => { await flush.flushAllDirty(); navigated=true; }, error=>error.message.includes('已取消切换')&&error.message.includes('disk full')&&!error.message.includes('article-1'));
  assert.equal(navigated,false);
  assert.ok(flush.lastFlushFailure('article-1'));
  fail=false; await flush.flushAllDirty();
  assert.equal(flush.lastFlushFailure('article-1'),undefined);
});

test('navigation awaits async recovery persistence', async () => {
  const flush=createDirtyFlusher(() => true);
  let finish, navigated=false;
  flush.registerDirtyFlush('a', () => new Promise(resolve => { finish=resolve; }));
  const pending=flush.flushAllDirty().then(() => { navigated=true; });
  assert.equal(navigated,false);
  finish(); await pending; assert.equal(navigated,true);
});

test('obsolete effect cleanup does not unregister the newer editor flush', async () => {
  const flush=createDirtyFlusher(() => true);
  let saved=0;
  const oldCleanup=flush.registerDirtyFlush('a', () => { throw Error('obsolete'); });
  flush.registerDirtyFlush('a', () => { saved++; }); oldCleanup();
  await flush.flushAllDirty(); assert.equal(saved,1);
});

test('only the current owner releases its retained recovery failure', async()=>{
 const flush=createDirtyFlusher(()=>true),oldCleanup=flush.registerDirtyFlush('shared',()=>{});
 const cleanup=flush.registerDirtyFlush('shared',()=>{throw Error('请先保存品牌资料');});
 await assert.rejects(flush.flushAllDirty(),/请先保存品牌资料/);oldCleanup();
 assert.equal(flush.lastFlushFailure('shared'),'请先保存品牌资料');cleanup();
 assert.equal(flush.lastFlushFailure('shared'),undefined);
});

test('chooser approves a fresh nonexisting child rather than the existing parent', () => {
  const approvals=new ExportApprovals();
  const target=approvals.issue(desktop);
  assert.equal(path.dirname(target),desktop);
  assert.equal(fs.existsSync(target),false);
  assert.equal(approvals.assert(target),target);
  assert.throws(() => approvals.assert(desktop), /未经/);
  assert.throws(() => approvals.assert(path.join(target,'..','unrelated')), /未经/);
  approvals.consume(target); assert.throws(() => approvals.assert(target), /未经/);
});

test('export grants expire and clear on account changes', () => {
  let now=1;
  const approvals=new ExportApprovals({now:() => now,ttlMs:10});
  const target=approvals.issue(desktop); now=11;
  assert.throws(() => approvals.assert(target), /过期/);
  const next=approvals.issue(desktop); approvals.clear();
  assert.throws(() => approvals.assert(next), /未经/);
  assert.throws(() => approvals.issue('C:\\Users'), /C 盘/);
});

test('desktop distribution includes export authorization boundary', () => {
  const config=JSON.parse(fs.readFileSync(path.join(desktop,'electron-builder.json'),'utf8'));
  assert.ok(config.files.includes('export-approval.cjs'));
});
