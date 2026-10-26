'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),f=JSON.parse(fs.readFileSync(path.join(repo,'docs/上线准备/memory-workflow-fixture.json')));
assert.equal(path.dirname(f.root),path.join(repo,'.test-tmp/release-interaction-lists'));assert(fs.existsSync(path.join(f.root,'.test-owner.json')));
const flag=name=>process.argv.includes(name),arg=(name,fallback)=>{const i=process.argv.indexOf(name);if(i<0)return fallback;const n=Number(process.argv[i+1]);assert(Number.isInteger(n)&&n>=0&&n<=120000,name);return n;};
const cycles=arg('--cycles',flag('--smoke')?1:20),dwell=arg('--dwell-ms',flag('--smoke')?0:10000),idle=arg('--idle-ms',flag('--smoke')?0:70000);assert(cycles>=1&&cycles<=60);
const result={state:'running',runtime:f.runtime,scope:'source Electron; real high-entropy PNG; offline protocol canvas; natural memory before optional final GC; shared working sets are summed, not unique physical RAM',cycles,dwell_ms:dwell,idle_ms:idle,image:f.large_image,samples:[],checks:{},started_at:new Date().toISOString()};
const output=path.join(f.root,'memory-workflow-result.json');
const save=()=>{const body=JSON.stringify(result,null,2);fs.writeFileSync(output,body);fs.writeFileSync(path.join(repo,'docs/上线准备/memory-workflow-native.json'),body);};save();
process.on('exit',()=>{if(result.state!=='finished')process.exitCode=1;});
const median=a=>{const s=[...a].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
(async()=>{let session;const started=Date.now();try{
 session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});const {evaluate:e,call,until}=session;
 const check=(name,value)=>{assert(value,name);result.checks[name]=true;save();};
 const button=t=>`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(t)})`;
 const activate=async expr=>{await until(`Boolean(${expr})&&!${expr}.disabled`);await e(`${expr}.click()`);};
 await e(`(()=>{const live=new Map(),create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=value=>{const u=create(value);live.set(u,value.size??0);return u};URL.revokeObjectURL=u=>{live.delete(u);revoke(u)};window.__memoryLeases=()=>({count:live.size,bytes:[...live.values()].reduce((a,b)=>a+b,0)})})()`);
 const remote=async()=> (await session.getTargets()).filter(t=>/^https:\/\/(app\.tapnow\.media|mp\.weixin\.qq\.com)\//.test(t.url));
 const sample=async(stage,cycle=null)=>{
  const heap=await call('Runtime.getHeapUsage'),dom=await call('Memory.getDOMCounters'),leases=await e('window.__memoryLeases()');
  const memory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'sample-owned-memory.ps1'),'-RootProcessId',String(session.pid)],{cwd:repo,encoding:'utf8',windowsHide:true}));
  const original_grants=f.original_stats&&fs.existsSync(f.original_stats)?JSON.parse(fs.readFileSync(f.original_stats)):null;
  const row={stage,cycle,original_grants,elapsed_ms:Date.now()-started,heap,dom,leases,remote_views:(await remote()).map(t=>({id:t.id,url:t.url})),memory};result.samples.push(row);save();console.log(JSON.stringify({stage,cycle,elapsed_ms:row.elapsed_ms,private_mb:Math.round(memory.private_bytes_total/1048576),working_set_mb:Math.round(memory.working_set_total/1048576),heap_mb:Math.round(heap.usedSize/1048576),leases:leases.count,remote_views:row.remote_views.length}));return row;
 };
 await until(`Boolean(document.querySelector('li[data-job-id="${f.jobs.completed}"] button'))`);await sample('cold');
 await activate(`[...document.querySelectorAll('li[data-job-id="${f.jobs.completed}"] button')].find(b=>b.innerText.trim()==='编辑正文')`);
 await until(`Boolean(document.querySelector('.ice-editor'))`);
 for(let cycle=1;cycle<=cycles;cycle++){
  result.progress='image-'+cycle;save();await activate(button('准备配图'));await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  const thumb=`document.querySelector('[data-candidate-id="${f.assets.large}"] .ice-asset-thumb')`;
  await activate(thumb);await until(`Boolean(document.querySelector('.ice-image-canvas img'))||document.body.innerText.includes('原图读取失败')`,45000);
  await until(`document.querySelector('.ice-image-canvas img')?.naturalWidth===3000`,45000);
  if(cycle===1||cycle===cycles)await sample('original-open',cycle);
  await activate(button('原始大小 100%'));await activate(button('适应窗口'));await activate(button('关闭原图'));
  await until(`!document.querySelector('.ice-image-canvas')`);await activate(button('关闭配图工作台'));
  await until(`!document.querySelector('.ice-asset-tabs')`);check('leases_released_cycle_'+cycle,(await e('window.__memoryLeases()')).count===0);
  result.progress='browser-'+cycle;save();await activate(button('网页工作台'));await until(`Boolean(document.querySelector('.ice-browser-region'))`);
  await until(`document.body.innerText.includes('离线画布已就绪')`);const initial=await remote();check('real_local_canvas_loaded_cycle_'+cycle,initial.length===1);
  await activate(button('返回文章'));await until(`!document.querySelector('.ice-browser-region')`);
  check('hiding_intentionally_keeps_one_view_cycle_'+cycle,(await remote()).length===1);
  await activate(button('网页工作台'));await until(`document.body.innerText.includes('离线画布已就绪')`);
  check('reopen_keeps_same_webcontents_cycle_'+cycle,(await remote()).some(t=>t.id===initial[0].id));
  await activate(button('微信公众号后台'));await until(`document.body.innerText.includes('离线画布已就绪')`);
  for(let retry=0;retry<40&&(await remote()).length!==2;retry++)await wait(100);
  check('two_sites_exist_cycle_'+cycle,(await remote()).length===2);
  if(cycle===1||cycle===cycles)await sample('both-sites-open',cycle);
  if(dwell)await wait(dwell);
  if(!flag('--baseline-close-current')){
   const releaseAll=`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('释放全部网页'))`;
   const ids=(await remote()).map(t=>t.id).sort();await activate(releaseAll);await until(`Boolean(${button('确认释放全部网页')})`);
   check('confirmation_preserves_pages_cycle_'+cycle,(await remote()).length===2);
   if(cycle===1){await activate(button('继续使用网页'));await until(`Boolean(document.querySelector('.ice-browser-region'))`);check('cancel_release_keeps_same_pages',JSON.stringify((await remote()).map(t=>t.id).sort())===JSON.stringify(ids));await activate(releaseAll);}
   await activate(button('确认释放全部网页'));await until(`!document.querySelector('.ice-browser-region')`);
  }else{
  // Baseline path: current-site release leaves the other hidden page until explicitly closed too.
  await activate(button('关闭并释放网页'));await until(`!document.querySelector('.ice-browser-region')`);
  check('current_release_leaves_hidden_site_cycle_'+cycle,(await remote()).length===1);
  await activate(button('网页工作台'));await until(`document.body.innerText.includes('离线画布已就绪')`);await activate(button('关闭并释放网页'));await until(`!document.querySelector('.ice-browser-region')`);
  }
  for(let retry=0;retry<40&&(await remote()).length!==0;retry++)await wait(100);
  check('all_views_released_cycle_'+cycle,(await remote()).length===0);
  await wait(1000);await sample('cycle-released',cycle);
 }
 await activate(button('← 返回对话'));await until(`!document.querySelector('.ice-editor')`);
 for(let spent=0;spent<idle;spent+=10000){await wait(Math.min(10000,idle-spent));console.log(JSON.stringify({stage:'natural-idle',elapsed_ms:Date.now()-started}));}
 const natural=await sample('natural-idle');
 // Separate diagnosis only. Normal measurements above never force GC.
 await call('HeapProfiler.collectGarbage');const forced=await sample('after-explicit-gc');
 const released=result.samples.filter(s=>s.stage==='cycle-released');
 if(released.length>=10){const warm=median(released.slice(2,6).map(s=>s.memory.private_bytes_total)),late=median(released.slice(-4).map(s=>s.memory.private_bytes_total));
  result.private_byte_growth=late-warm;check('post_warm_private_bytes_bounded',late-warm<=128*1048576);}
 check('final_no_remote_pages',natural.remote_views.length===0);check('final_no_image_leases',natural.leases.count===0);if(natural.original_grants)check('final_no_original_file_grants',natural.original_grants.active===0&&natural.original_grants.opening===0);
 check('retained_heap_after_diagnostic_gc_bounded',forced.heap.usedSize<64*1048576);check('no_renderer_exceptions',session.errors.length===0);
 result.duration_ms=Date.now()-started;result.state='finished';
}catch(error){result.state='failed';result.error=String(error.stack||error);if(session)try{result.dom=await session.evaluate('document.body.innerText');result.renderer_errors=session.errors;}catch{}}
finally{if(session)await session.close();result.finished_at=new Date().toISOString();save();console.log(JSON.stringify({state:result.state,output,checks:Object.keys(result.checks).length,error:result.error}));}})();
