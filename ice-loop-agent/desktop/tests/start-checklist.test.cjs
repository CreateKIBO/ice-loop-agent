'use strict';
// 批A6/B2（2026-10-23 体验完善）：入门清单状态推导与收起偏好的行为回归。
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function compile(relative){
 const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',relative)],bundle:true,write:false,format:'cjs',platform:'node',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});
 const m=new Module(path.join(UI,'.start-checklist-test.cjs'));m.filename=path.join(UI,'.start-checklist-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(result.outputFiles[0].text,m.filename);return m.exports;
}
const checklist=compile('features/chat/startChecklist.ts');

test('checklist status derives only from observable data and keeps real meanings',()=>{
  const base={hasAccount:true,columnCount:2,readiness:'ready',hasLibrary:true};
  assert.deepEqual(checklist.checklistStatus(base).map(item=>[item.key,item.done]),
    [['account',true],['model',true],['history',true]]);
  const cold=checklist.checklistStatus({hasAccount:true,columnCount:0,readiness:'missing',hasLibrary:false});
  assert.deepEqual(cold.map(item=>item.done),[false,false,false]);
  // 保存 Key ≠ 连接成功：untested 与 unrouted 都不算就绪，且说明保留真实含义。
  const untested=checklist.checklistStatus({...base,readiness:'untested'}).find(item=>item.key==='model');
  assert.equal(untested.done,false);assert.ok(untested.note.includes('还没有通过连接测试'));
  const unrouted=checklist.checklistStatus({...base,readiness:'unrouted'}).find(item=>item.key==='model');
  assert.equal(unrouted.done,false);assert.ok(unrouted.note.includes('尚未使用'));
  const unknown=checklist.checklistStatus({...base,readiness:'unknown'}).find(item=>item.key==='model');
  assert.equal(unknown.done,false);assert.ok(unknown.note.includes('正在读取'));
});

test('dismissed preference is per-account, safe against corruption and storage failures',()=>{
  const store=new Map(),broken={getItem:()=>{throw Error('quota');},setItem:()=>{throw Error('quota');},removeItem:()=>{throw Error('quota');}};
  const storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  assert.equal(checklist.loadStartChecklistDismissed(storage,'accA'),false);
  assert.equal(checklist.saveStartChecklistDismissed(storage,'accA',true),true);
  assert.equal(checklist.loadStartChecklistDismissed(storage,'accA'),true);
  assert.equal(checklist.loadStartChecklistDismissed(storage,'accB'),false); // 账号隔离
  store.set('ice.ui.startcheck.v1.accA','{corrupt');
  assert.equal(checklist.loadStartChecklistDismissed(storage,'accA'),false); // 非法值回退显示
  assert.equal(checklist.saveStartChecklistDismissed(storage,'accA',false),true);
  assert.equal(store.has('ice.ui.startcheck.v1.accA'),false);
  assert.equal(checklist.loadStartChecklistDismissed(broken,'accA'),false);   // 存储故障不抛错
  assert.equal(checklist.saveStartChecklistDismissed(broken,'accA',true),false);
});
