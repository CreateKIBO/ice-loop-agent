const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const src=fs.readFileSync(path.join(__dirname,'../ui/src/features/editor/reviewDraftPersistence.ts'),'utf8');
const mod={exports:{}};new Function('module','exports',esbuild.transformSync(src,{loader:'ts',format:'cjs'}).code)(mod,mod.exports);
const {ReviewDraftPersistence:P,reviewDecisionCounts:counts}=mod.exports;
const d=(text)=>({op_index:0,decision:'new_text',text});
test('review saves serialize latest input and concurrent flushes do not duplicate writes',async()=>{
 let resolve,calls=[];
 const p=new P(async(id,hash,version,items)=>{calls.push({id,version,items});if(calls.length===1)await new Promise(r=>resolve=r);return {version:version+1,decisions:items};});
 p.install('p','h',null);p.edit('p',d('first'));const pending=p.flush();
 await Promise.resolve();assert.equal(calls.length,1);
 p.edit('p',d('latest'));const second=p.flush();resolve();await Promise.all([pending,second]);
 assert.equal(calls.length,2);assert.equal(calls[1].version,1);assert.equal(calls[1].items[0].text,'latest');assert(!p.dirty);p.cancelTimer();
});
test('failed review saves preserve input and retry the same version, then resume queue',async()=>{
 let fail=true,calls=[];const p=new P(async(id,h,v,items)=>{calls.push(v);if(fail)throw Error('disk-full');return {version:v+1,decisions:items};});
 p.install('p','h',null);p.edit('p',d('unsaved'));await assert.rejects(p.flush(),/disk-full/);
 assert(p.dirty);assert.equal(p.state,'error');assert.equal(p.decisions('p')[0].text,'unsaved');
 fail=false;await p.flush();assert.deepEqual(calls,[0,0]);assert(!p.dirty);assert.equal(p.error,null);p.cancelTimer();
});
test('late detail reads cannot overwrite local review and new instances restore saved decisions',async()=>{
 let stored;const p=new P(async(id,h,v,items)=>stored={version:v+1,decisions:items});p.install('p','h',null);p.edit('p',d('mine'));
 p.install('p','h',{version:10,decisions:[d('late')]});assert.equal(p.decisions('p')[0].text,'mine');await p.flush();
 const next=new P(async()=>{throw Error('unexpected write')});next.install('p','h',stored);assert.equal(next.decisions('p')[0].text,'mine');assert(!next.dirty);
 next.forget('p');assert.deepEqual(next.decisions('p'),{});p.cancelTimer();next.cancelTimer();
});
test('review confirmation counts only existing operations and separates undecided',()=>{
 assert.deepEqual(counts(5,{0:{op_index:0,decision:'accept'},1:{op_index:1,decision:'reject'},2:d('manual'),90:d('stale')}),{accept:1,reject:1,new_text:1,undecided:2});
});

test('explicit reload replaces only selected review and clean old proposals are evicted',async()=>{
 const p=new P(async(id,h,v,items)=>({version:v+1,decisions:items}));
 p.install('one','h',{version:1,decisions:[d('saved-one')]});p.install('two','h',null);assert.deepEqual(p.decisions('one'),{});
 p.edit('two',d('unsaved-two'));p.install('three','h',null);p.edit('three',d('unsaved-three'));p.cancelTimer();await p.settle();
 p.replace('two','h',{version:8,decisions:[d('remote-two')]});assert.equal(p.decisions('two')[0].text,'remote-two');
 assert.equal(p.decisions('three')[0].text,'unsaved-three');assert(p.dirty);
 p.cancelTimer();
});

test('processed proposal keeps local manual text and blocks leaving until explicit removal, without replay',async()=>{
 const writes=[];const p=new P(async(id,h,v,items)=>{writes.push(id);return {version:v+1,decisions:items};});
 p.install('processed','h',null);p.edit('processed',d('manual recovery'));p.retire('processed','rejected');
 p.install('other','h',null);p.edit('other',d('keep other draft'));
 await assert.rejects(p.flush(),/本地审阅记录/);
 assert.deepEqual(writes,['other']);assert.equal(p.retiredRecords()[0].items[0].text,'manual recovery');assert(p.dirty);
 p.forget('processed');assert(!p.dirty);assert.equal(p.decisions('other')[0].text,'keep other draft');
 await p.flush();assert.deepEqual(writes,['other']);p.cancelTimer();
});
