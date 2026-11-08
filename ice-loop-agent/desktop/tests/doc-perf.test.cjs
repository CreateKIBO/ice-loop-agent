"use strict";
// v3.12 编辑器性能读数：计时只归属当前打开的文章；分位数与上限。
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function compile(name){const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',name)],bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'});const mod=new Module(path.join(UI,'.perf-test.cjs'));mod.filename=path.join(UI,'.perf-test.cjs');mod.paths=Module._nodeModulePaths(UI);mod._compile(result.outputFiles[0].text,mod.filename);return mod.exports;}
let clock=0;const frames=[];
global.performance={now:()=>clock,memory:{usedJSHeapSize:50*1024*1024}};
global.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
const flush=()=>{while(frames.length)frames.shift()();};
const {docPerf}=compile('features/documents/docPerf.ts');
test('open/loaded/editable are measured from the open request of the same document',()=>{
 clock=1000;docPerf.open('doc-a');clock=1120;docPerf.loaded('doc-b');docPerf.loaded('doc-a');clock=1400;docPerf.editable('doc-a');
 const snap=docPerf.snapshot();assert.equal(snap.documentId,'doc-a');assert.equal(snap.openMs,120);assert.equal(snap.editableMs,400);
 clock=1500;docPerf.loaded('doc-a');assert.equal(docPerf.snapshot().openMs,120,'只记第一次');
 assert.equal(snap.heapMb,50);
});
test('keystrokes and saves give percentiles; other documents are ignored; reopening resets',()=>{
 clock=0;docPerf.open('doc-a');
 for(let i=1;i<=20;i++){clock=i*100;docPerf.keystroke('doc-a');clock+=i;flush();}
 docPerf.keystroke('doc-b');flush();
 docPerf.saved('doc-a',30);docPerf.saved('doc-a',90);docPerf.saved('doc-b',999);
 const snap=docPerf.snapshot();
 assert.equal(snap.input.count,20);assert.equal(snap.input.p50,11);assert.equal(snap.input.p95,20);assert.equal(snap.input.max,20);
 assert.deepEqual([snap.saves.count,snap.saves.max,snap.saves.last],[2,90,90]);
 docPerf.open('doc-c');assert.equal(docPerf.snapshot().input.count,0);assert.equal(docPerf.snapshot().saves.count,0);
});
