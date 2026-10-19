'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../ui/node_modules/typescript');const {ExportApprovals}=require('../export-approval.cjs');
const file=path.join(__dirname,'../ui/src/features/editor/exportModel.ts'),code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const m={exports:{}};new Function('module','exports',code)(m,m.exports);const {exportProblems}=m.exports;
const parent=path.resolve(__dirname,'../../.test-tmp');fs.mkdirSync(parent,{recursive:true});const owned=fs.mkdtempSync(path.join(parent,'export-receipt-'));
test.after(()=>{const resolved=fs.realpathSync(owned);assert.equal(path.dirname(resolved),fs.realpathSync(parent));assert.equal(fs.lstatSync(owned).isSymbolicLink(),false);fs.rmSync(owned,{recursive:true,force:true});});

test('draft feedback includes missing images, outputs and unmanaged references without duplicate messages',()=>{
 assert.deepEqual(exportProblems({missing_images:[2],pending_placeholders:1,run_refs_unresolved:['a','b'],unmanaged_images:[{caption:'原稿图片'}]}),['图2尚未完成','存在未解析的运行输出','图片「原稿图片」尚未归档到本篇配图']);
 assert.deepEqual(exportProblems({pending_placeholders:3}),['还有3处待配图']);assert.deepEqual(exportProblems({}),[]);
 assert.deepEqual(exportProblems({blocking:['图2缺少已采纳图片'],missing_images:[2]}),['图2缺少已采纳图片']);
});
test('only granted completed exports can become folder-opening receipts',()=>{
 const grants=new ExportApprovals(),target=grants.issue(owned);assert.throws(()=>grants.completedPath(target),/先完成|不属于/);
 assert.equal(grants.complete(path.join(owned,'unissued')),false);fs.mkdirSync(target);
 assert.equal(grants.complete(target),true);assert.throws(()=>grants.assert(target),/未经/);assert.equal(grants.completedPath(target),target);
 assert.throws(()=>grants.completedPath(owned),/不属于/);
});
test('completed receipts expire and disappear on account changes',()=>{
 let now=1;const grants=new ExportApprovals({now:()=>now,ttlMs:10}),target=grants.issue(owned);fs.mkdirSync(target);grants.complete(target);
 now=11;assert.throws(()=>grants.completedPath(target),/过期/);
 const next=grants.issue(owned);fs.mkdirSync(next);grants.complete(next);grants.clear();assert.throws(()=>grants.completedPath(next),/不属于/);
});
test('cancelled grants cannot later acquire completed receipts',()=>{
 const grants=new ExportApprovals(),target=grants.issue(owned);grants.consume(target);assert.equal(grants.complete(target),false);
});
test('receipts validate the current path instead of trusting a moved export directory',()=>{
 const grants=new ExportApprovals(),target=grants.issue(owned);fs.mkdirSync(target);grants.complete(target);fs.rmdirSync(target);
 assert.throws(()=>grants.completedPath(target));
});
