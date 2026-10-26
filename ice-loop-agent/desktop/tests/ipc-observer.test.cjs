'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const {observeIpc}=require('./ipc-observer.cjs');
function harness(t) {
  const parent=path.resolve(__dirname,'../../.test-tmp/ipc-observer-unit');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'case-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const paths=Object.fromEntries(['observed','trace','fault'].map(k=>[k,path.join(root,k+'.jsonl')]));
  fs.writeFileSync(paths.fault,'{}');
  const handlers=new Map(), children=[];
  const ipcMain={handle:(c,fn)=>handlers.set(c,fn)};
  observeIpc({...paths,ipcMain,BrowserWindow:{getAllWindows:()=>[{webContents:{getURL:()=> 'ice://app/'},contentView:{children}}]}});
  const rows=k=>fs.existsSync(paths[k])?fs.readFileSync(paths[k],'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  return {...paths,rows,children,register:(c,fn)=>{ipcMain.handle(c,fn);return handlers.get(c);}};
}
test('all non-request handlers are invoked exactly once; original result passes through',async t=>{
  const h=harness(t);let calls=0;
  for(const channel of ['ice:browser-show','ice:choose-export-dir','ice:save-key']) {
    const payload={opaque:channel};
    const call=h.register(channel,async(...args)=>{calls++;assert.deepEqual(args,['event',payload]);return payload;});
    assert.equal(await call('event',payload),payload);
  }
  assert.equal(calls,3);assert.deepEqual(h.rows('trace').map(r=>r.phase),['started','resolved','started','resolved','started','resolved']);
});
test('browser IDs are observed after original async handler attaches its view',async t=>{
 const h=harness(t);
 const call=h.register('ice:browser-show',async()=>{await Promise.resolve();h.children.push({webContents:{id:27}});return {ok:true};});
 assert.deepEqual(await call(),{ok:true});assert.deepEqual(h.rows('observed'),[{channel:'ice:browser-show',ids:[27]}]);
});
test('true rejections are traced and rethrown without leaking errors or payloads',async t=>{
 const h=harness(t), error=Error('private token secret-body');
 const call=h.register('ice:request',async()=>{throw error});
 await assert.rejects(call(null,'jobs.resume',{account_id:'A',private:'secret-body'}),e=>e===error);
 assert.deepEqual(h.rows('observed').map(r=>r.ok),[false]);
 const trace=h.rows('trace');assert.deepEqual(trace.map(r=>r.phase),['started','rejected']);assert.equal(trace[0].id,trace[1].id);
 assert.ok(!fs.readFileSync(h.trace,'utf8').includes('secret-body'));
});
test('injected faults bypass original handler but still produce entry and rejected evidence',async t=>{
 const h=harness(t);fs.writeFileSync(h.fault,JSON.stringify({fail:['chat.list']}));let calls=0;
 const call=h.register('ice:request',async()=>{calls++;});await assert.rejects(call(null,'chat.list',{}),/NETWORK/);
 assert.equal(calls,0);assert.deepEqual(h.rows('trace').map(r=>r.phase),['started','rejected']);
});
test('pending handler has started evidence before completion; receipt count remains settled only',async t=>{
 const h=harness(t);let settle;const gate=new Promise(r=>settle=r);
 const call=h.register('ice:request',async()=>{await gate;return 13});
 const result=call(null,'jobs.stop',{account_id:'A'});
 assert.deepEqual(h.rows('trace').map(r=>r.phase),['started']);assert.equal(h.rows('observed').length,0);
 settle();assert.equal(await result,13);assert.equal(h.rows('observed')[0].ok,true);
});

test('response delay occurs after original execution and before caller resolution',async t=>{
 const h=harness(t);fs.writeFileSync(h.fault,JSON.stringify({responseDelayMs:{'chat.list':30}}));
 const call=h.register('ice:request',async()=>['A-private-body']);
 const result=call(null,'chat.list',{account_id:'A'});
 await Promise.resolve();
 assert.deepEqual(h.rows('trace').map(r=>r.phase),['started','handler_returned']);
 assert.equal(h.rows('observed').length,0);assert.deepEqual(await result,['A-private-body']);
 assert.deepEqual(h.rows('trace').map(r=>r.phase),['started','handler_returned','resolved']);
 assert.ok(!fs.readFileSync(h.trace,'utf8').includes('private-body'));
});
