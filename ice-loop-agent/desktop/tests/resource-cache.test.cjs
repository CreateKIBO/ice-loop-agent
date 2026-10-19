'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function load(file){
  const code=esbuild.buildSync({entryPoints:[path.join(UI,'src/data',file)],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'}).outputFiles[0].text;
  const m=new Module(path.join(UI,'.resource-test.cjs'));m.filename=path.join(UI,'.resource-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(code,m.filename);return m.exports;
}
const {ResourceCache}=load('resourceCache.ts');
const {boundStreamEvents,advanceCursor}=load('eventStream.ts');

test('cache growth stays bounded across thousands of conversation streams',()=>{
  const cache=new ResourceCache(20,1024,1000,value=>value.length*2,()=>0);
  for(let i=0;i<2000;i++){cache.set('account|stream-'+i,'x'.repeat(40));assert.ok(cache.stats().entries<=20);assert.ok(cache.stats().bytes<=1024);}
  assert.equal(cache.get('account|stream-0'),undefined);assert.equal(cache.get('account|stream-1999'),'x'.repeat(40));
});
test('cache evicts least recently used entries and clears idle records',()=>{
  let now=0;const cache=new ResourceCache(2,1000,100,value=>value.length,()=>now);
  cache.set('a','a');cache.set('b','b');cache.get('a');cache.set('c','c');
  assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a'),'a');
  now=101;assert.deepEqual(cache.stats(),{entries:0,bytes:0});
});
test('an oversized entry cannot evict everything or exceed the total budget',()=>{
  const cache=new ResourceCache(2,10,100,v=>v.length,()=>0);cache.set('a','ok');
  assert.equal(cache.set('big','x'.repeat(11)),false);assert.equal(cache.get('a'),'ok');
  cache.clear();assert.deepEqual(cache.stats(),{entries:0,bytes:0});
});
test('one large tool result cannot defeat retained-event byte limits; cursor still advances',()=>{
  const events=[{sequence:1,type:'tool.result',payload:{output:'x'.repeat(2000)}},
    {sequence:2,type:'turn.finished',payload:{status:'completed'}}];
  const kept=boundStreamEvents(events,512);
  assert.deepEqual(kept.map(row=>row.sequence),[2]);assert.equal(advanceCursor(0,events),2);
  assert.equal(boundStreamEvents([{sequence:3,type:'tool.result',payload:{output:'x'.repeat(2000)}}],512).length,0);
});

test('switching publication clears old citations and selected editing objects',()=>{
  const client=load('client.ts');
  client.accountStore.set('a');client.conversationStore.set('conversation-a');client.editorStore.set('job-a');
  client.citationStore.add({chunkId:'chunk-a',displayName:'A的私有资料',section:'',hash:'hash-a'});
  client.resetForAccountSwitch('b');
  assert.equal(client.accountStore.get(),'b');assert.equal(client.conversationStore.get(),null);
  assert.equal(client.editorStore.get(),null);assert.equal(client.citationStore.get().length,0);
});
