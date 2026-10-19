'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module');
const esbuild=require('esbuild');
const file=path.resolve(__dirname,'../ui/src/features/editor/editorPersistence.ts');
const moduleUnderTest=new Module(file);
moduleUnderTest._compile(esbuild.buildSync({entryPoints:[file],bundle:true,write:false,format:'cjs'}).outputFiles[0].text,file);
const {EditorPersistence}=moduleUnderTest.exports;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};

test('delayed auto-save cannot finish after and overwrite a newer recovery draft',async()=>{
  const gate=deferred(),writes=[];
  const editor=new EditorPersistence(async(method,params)=>{writes.push(params.content);if(params.content==='old')await gate.promise;return{}},'job');
  editor.setBaseline('initial');
  const first=editor.saveDraft('old'),second=editor.saveDraft('new');
  await Promise.resolve();assert.deepEqual(writes,['old']);gate.resolve();
  await Promise.all([first,second]);assert.deepEqual(writes,['old','new']);
});
test('queued draft after version save uses new baseline, latest input remains the recovery value',async()=>{
  const gate=deferred(),calls=[];
  const editor=new EditorPersistence(async(method,params)=>{calls.push({method,...params});if(method==='articles.save'){await gate.promise;return{content_hash:'saved-hash',revision_id:'r1'}}return{}},'job');
  editor.setBaseline('old-hash');
  const version=editor.saveVersion('submitted'),newer=editor.saveDraft('typed during save');
  await Promise.resolve();assert.equal(calls.length,1);gate.resolve();await Promise.all([version,newer]);
  assert.deepEqual(calls.map(c=>[c.method,c.content??c.body,c.base_revision??c.content_hash]),[
    ['articles.save','submitted','old-hash'],['articles.editor_draft_save','submitted','saved-hash'],
    ['articles.editor_draft_save','typed during save','saved-hash']]);
});
test('failed write retains baseline and allows a successful explicit retry',async()=>{
  let fail=true;const editor=new EditorPersistence(async(method)=>{if(fail)throw Error('conflict');return method==='articles.save'?{content_hash:'new',revision_id:'r'}:{}},'job');
  editor.setBaseline('old');await assert.rejects(editor.saveVersion('text'),/conflict/);assert.equal(editor.baseline,'old');
  fail=false;await editor.saveVersion('text');assert.equal(editor.baseline,'new');
});
test('empty recovery text is written without changing the published baseline',async()=>{
  const calls=[];const editor=new EditorPersistence(async(method,params)=>{calls.push(params);return{}},'job');
  editor.setBaseline('original');await editor.saveDraft('');assert.equal(calls[0].content,'');assert.equal(editor.baseline,'original');
});
test('successful version with recovery failure is reported as saved with a separate recoverable error',async()=>{
  const editor=new EditorPersistence(async method=>{if(method==='articles.save')return{content_hash:'new',revision_id:'r'};throw Error('disk busy')},'job');
  editor.setBaseline('old');const result=await editor.saveVersion('submitted');
  assert.equal(result.content_hash,'new');assert.equal(editor.baseline,'new');assert.equal(result.draftError,'disk busy');
});
