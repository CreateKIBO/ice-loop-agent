'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),f=JSON.parse(fs.readFileSync(path.join(repo,'docs/上线准备/memory-workflow-fixture.json')));
assert.equal(path.dirname(f.root),path.join(repo,'.test-tmp/release-interaction-lists'));assert(fs.existsSync(path.join(f.root,'.test-owner.json')));
const result={state:'running',runtime:f.runtime,scope:'real desktop IPC and protected protocol; isolated HTTPS fixture with CSP bypass only inside its test target',checks:{}};
const save=()=>{const json=JSON.stringify(result,null,2);fs.writeFileSync(path.join(f.root,'original-images-result.json'),json);fs.writeFileSync(path.join(repo,'docs/上线准备/original-images-native.json'),json);};save();
process.on('exit',()=>{if(result.state!=='finished')process.exitCode=1;});
async function remoteEval(target,expression){const ws=new WebSocket(target.webSocketDebuggerUrl);let sequence=0;const pending=new Map();await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const r=JSON.parse(event.data),p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('remote probe timeout'));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 try{await call('Page.setBypassCSP',{enabled:true});const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('probe closed'));}ws.close();}}
(async()=>{let session;try{
 session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});const {evaluate:e,until}=session;
 const check=(n,v)=>{assert(v,n);result.checks[n]=true;save();};
 const reference={kind:'candidate',account_id:f.account_a,job_id:f.jobs.completed,candidate_id:f.assets.selected};
 await until(`Boolean(document.querySelector('#ice-account-select'))`);
 const denied=await e(`window.ice.request('images.original_source',${JSON.stringify(reference)}).then(()=>false,()=>true)`);check('raw_path_resolver_not_in_renderer_rpc_allowlist',denied);
 check('wrong_account_cannot_open_original',await e(`window.ice.openOriginalImage(${JSON.stringify({...reference,account_id:f.account_b})}).then(()=>false,()=>true)`));
 const grant=await e(`window.ice.openOriginalImage(${JSON.stringify(reference)})`);
 check('renderer_receives_only_capability_not_path_or_body',!('file_path' in grant)&&!('data_url' in grant)&&/^ice:\/\/app\/__image\/[a-f0-9]{48}$/.test(grant.url));
 const expected=crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root,'viewer-original.png'))).digest('hex');
 const own=await e(`fetch(${JSON.stringify(grant.url)}).then(async r=>({status:r.status,sha:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await r.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('')}))`);
 check('owner_stream_returns_exact_original_bytes',own.status===200&&own.sha===expected);
 await e(`window.ice.browserShow({site:'tapnow',bounds:{x:100,y:150,width:900,height:600}})`);
 let target;for(let i=0;i<80;i++){target=(await session.getTargets()).find(t=>t.url.startsWith('https://app.tapnow.media'));if(target)break;await wait(100);}assert(target);
 const attack=await remoteEval(target,`new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(true);image.onerror=()=>resolve(false);image.src=${JSON.stringify(grant.url)};})`);
 check('real_remote_partition_cannot_load_even_known_capability',attack===false);
 await remoteEval(target,"document.cookie='owned-memory-login=kept;path=/;max-age=3600;SameSite=Lax';document.cookie");
 await e(`window.ice.browserCommand('close-all')`);check('release_all_destroys_webcontents',(await session.getTargets()).every(t=>!t.url.startsWith('https://app.tapnow.media')));
 await e(`window.ice.browserShow({site:'tapnow',bounds:{x:100,y:150,width:900,height:600}})`);
 for(let i=0;i<80;i++){target=(await session.getTargets()).find(t=>t.url.startsWith('https://app.tapnow.media'));if(target)break;await wait(100);}
 check('release_all_keeps_login_cookie',(await remoteEval(target,'document.cookie')).includes('owned-memory-login=kept'));
 await e(`window.ice.browserCommand('close-all')`);await e(`window.ice.releaseOriginalImage(${JSON.stringify(grant.token)})`);
 check('release_revokes_original_url',await e(`fetch(${JSON.stringify(grant.url)},{method:'HEAD'}).then(r=>r.status)`)===404);
 const next=await e(`window.ice.openOriginalImage(${JSON.stringify(reference)})`);
 await e(`window.ice.request('accounts.switch',{account_id:${JSON.stringify(f.account_b)}})`);
 check('account_switch_revokes_old_original_url',await e(`fetch(${JSON.stringify(next.url)},{method:'HEAD'}).then(r=>r.status)`)===404);
 await e(`window.ice.request('accounts.switch',{account_id:${JSON.stringify(f.account_a)}})`);
 check('source_and_download_files_remain_unchanged',crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root,'viewer-original.png'))).digest('hex')===expected&&fs.existsSync(f.downloads.bind.file_path)&&fs.existsSync(f.downloads.discard.file_path));
 check('all_original_handles_released',JSON.parse(fs.readFileSync(f.original_stats)).active===0);
 check('no_renderer_exceptions',session.errors.length===0);result.state='finished';
}catch(error){result.state='failed';result.error=String(error.stack||error);if(session)try{result.dom=await session.evaluate('document.body.innerText');result.errors=session.errors;}catch{}}
finally{if(session)await session.close();save();console.log(JSON.stringify({state:result.state,checks:Object.keys(result.checks).length,root:f.root,error:result.error}));}})();
