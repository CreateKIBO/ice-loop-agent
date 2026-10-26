'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
test('local workbench permits owned image blobs while scripts and connections stay local',()=>{
 const html=require('node:fs').readFileSync(path.join(UI,'index.html'),'utf8');
 assert.match(html,/img-src 'self' data: ice: blob:/);assert.match(html,/script-src 'self';/);assert.match(html,/connect-src 'self' ice:;/);
 assert.match(html,/object-src 'none'/);assert.ok(!html.includes('script-src *'));
});
function compile(relative){
 const result=esbuild.buildSync({entryPoints:[path.join(UI,'src/features/assets',relative)],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});
 const m=new Module(path.join(UI,'.asset-test.cjs'));m.filename=path.join(UI,'.asset-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(result.outputFiles[0].text,m.filename);return m.exports;
}
const {imageLease,fitImage,boundedZoom}=compile('imageLease.ts'),model=compile('assetModel.ts');
const {ImageQueue}=compile('imageQueue.ts');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('image requests serialize real work and prioritize an original over waiting thumbnails',async()=>{
 const queue=new ImageQueue(),gate=deferred(),events=[],signal=new AbortController().signal;
 const first=queue.run(async()=>{events.push('first');await gate.promise;return 1;},signal);
 const second=queue.run(async()=>{events.push('thumbnail');return 2;},signal);
 const original=queue.run(async()=>{events.push('original');return 3;},signal,true);
 await tick();assert.deepEqual(events,['first']);assert.equal(queue.pending,2);
 gate.resolve();assert.deepEqual(await Promise.all([first,second,original]),[1,2,3]);await tick();
 assert.deepEqual(events,['first','original','thumbnail']);assert.equal(queue.inFlight,0);assert.equal(queue.pending,0);
});
test('leaving while queued prevents IO, and cancelling in-flight work holds capacity until it actually finishes',async()=>{
 const queue=new ImageQueue(),gate=deferred(),active=new AbortController(),queued=new AbortController();let calls=0;
 const first=queue.run(async()=>{await gate.promise;return 1;},active.signal);
 const firstRejected=assert.rejects(first,{name:'AbortError'});
 const second=queue.run(async()=>{calls++;return 2;},queued.signal);
 const secondRejected=assert.rejects(second,{name:'AbortError'});
 await tick();active.abort();queued.abort();await Promise.all([firstRejected,secondRejected]);
 assert.equal(calls,0);assert.equal(queue.pending,0);assert.equal(queue.inFlight,1);
 const third=queue.run(async()=>{calls++;return 3;},new AbortController().signal);await tick();assert.equal(calls,0);
 gate.resolve();assert.equal(await third,3);await tick();assert.equal(queue.inFlight,0);
});
test('strict-mode cleanup before the IO microtask does not launch a stale request',async()=>{
 const queue=new ImageQueue(),control=new AbortController();let calls=0;
 const request=queue.run(async()=>++calls,control.signal);control.abort();await assert.rejects(request,{name:'AbortError'});await tick();
 assert.equal(calls,0);assert.equal(queue.inFlight,0);
 const stopped=new AbortController();stopped.abort();await assert.rejects(queue.run(async()=>++calls,stopped.signal));assert.equal(calls,0);
});
test('a failed decoder request cannot poison later visible images',async()=>{
 const queue=new ImageQueue(),signal=new AbortController().signal;
 const failed=queue.run(async()=>{throw Error('bad image');},signal),next=queue.run(async()=>42,signal);
 await assert.rejects(failed,/bad image/);assert.equal(await next,42);await tick();assert.equal(queue.inFlight,0);
});
test('rapidly leaving a large resource page removes cancelled queue metadata without starting hidden reads',async()=>{
 const queue=new ImageQueue(),gate=deferred(),controls=Array.from({length:100},()=>new AbortController());let calls=0;
 const requests=controls.map(control=>queue.run(async()=>{calls++;await gate.promise;return 1;},control.signal));
 const settled=Promise.allSettled(requests);await tick();for(const control of controls)control.abort();await settled;
 assert.equal(queue.pending,0);assert.equal(calls,1);assert.equal(queue.inFlight,1);gate.resolve();await tick();assert.equal(queue.inFlight,0);
});
test('original image lease preserves bytes and is unusable after release',async()=>{
 const lease=imageLease('data:image/png;base64,aGVsbG8=');
 assert.ok(lease.url.startsWith('blob:'));assert.equal(await(await fetch(lease.url)).text(),'hello');
 lease.release();lease.release();await assert.rejects(fetch(lease.url));
});
test('preview leases reject remote HTML and unsupported mime instead of loading it',()=>{
 for(const value of ['https://example.com/a.png','data:text/html;base64,aGVsbG8=','data:image/svg+xml;base64,aGVsbG8=','blob:abc','not-an-image'])assert.throws(()=>imageLease(value));
});
test('fit and zoom never create NaN or unbounded image dimensions',()=>{
 assert.equal(fitImage({width:2400,height:1200},{width:1224,height:624}),.5);
 assert.equal(fitImage({width:100,height:100},{width:1224,height:624}),1);
 assert.equal(fitImage({width:0,height:0},{width:100,height:100}),1);
 assert.equal(boundedZoom(Infinity),1);assert.equal(boundedZoom(500),4);assert.equal(boundedZoom(0),.01);
});
test('large account asset libraries are searchable beyond the first page without mutating their order',()=>{
 const rows=Array.from({length:27},(_,i)=>({resource_id:String(i),title:'图片'+i,usage:'illustration',tags:i===26?['循环截图']:[]}));
 const before=JSON.stringify(rows),last=model.resourcePage(rows,'','body_ai',99);
 assert.equal(last.pages,3);assert.equal(last.rows.length,3);assert.equal(last.total,27);
 assert.equal(model.resourcePage(rows,'循环','body_real',0).rows[0].resource_id,'26');assert.equal(JSON.stringify(rows),before);
 assert.equal(model.resourcePage(rows,'missing','body_ai',0).pages,1);
});
test('resource ordering prioritizes matching purpose without hiding other resources',()=>{
 const rows=[{resource_id:'a',title:'A',usage:'illustration'},{resource_id:'b',title:'B',usage:'cover'}];
 const result=model.resourcePage(rows,'','cover',0);assert.equal(result.rows[0].resource_id,'b');assert.equal(result.total,2);
});
test('cancelled and failed programs cannot be offered as capture sources',()=>{
 assert.deepEqual(model.usableRunKeys({runs:{a:{verdict:'ok'},b:{verdict:'cancelled'},c:{verdict:'timed_out'},d:{verdict:'expected_failure_ok'}}}),['a','d']);
});
test('prompt edits carry the actual article and slot version, screenshots never get AI prompts',()=>{
 const data={job:{job_id:'j'},body_hash:'current-body',cover_prompt:'cover-current'};
 const slot={figure_no:8,kind:'body_real',content_hash:'current-slot',prompt:'forbidden'};
 assert.equal(model.slotPrompt(data,slot),'');assert.deepEqual(model.promptParams(data,slot),{job_id:'j',figure_no:8,content_hash:'current-slot',body_hash:'current-body'});
 assert.equal(model.slotPrompt(data,{...slot,kind:'cover',prompt:''}),'cover-current');
});
test('original requests are explicitly scoped and cannot reuse the thumbnail response',()=>{
 const {previewRequest}=compile('ImageViewer.tsx');
 const target={kind:'candidate',accountId:'account-a',jobId:'j',candidateId:'c',caption:'caption'};
 assert.equal(previewRequest(target).params.original,false);assert.equal(previewRequest(target,true).params.original,true);
 assert.equal(previewRequest(target,true).params.account_id,'account-a');
 assert.equal(previewRequest({kind:'resource',accountId:'b',resourceId:'r',caption:''},true).method,'resources.preview');
});

test('binary original leases preserve bytes and revoke without base64 expansion',async()=>{
 const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
 const lease=imageLease(new Blob([bytes],{type:'image/png'}));
 assert.deepEqual(new Uint8Array(await (await fetch(lease.url)).arrayBuffer()),bytes);
 lease.release();lease.release();await assert.rejects(fetch(lease.url));
 assert.throws(()=>imageLease(new Blob(['bad'],{type:'text/html'})));
 assert.throws(()=>imageLease(new Blob([],{type:'image/png'})));
});
