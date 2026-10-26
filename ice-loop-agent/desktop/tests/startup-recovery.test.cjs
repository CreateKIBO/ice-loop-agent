"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {resolveWorkspace,StartupRecovery,publishWorkspace,checkedRuntime,recoveryRequest}=require('../startup-recovery.cjs');
const repo=path.resolve(__dirname,'../..');
function fixture(){
 const root=fs.mkdtempSync(path.join(repo,'.test-tmp/startup-recovery-'));
 const runtime=path.join(root,'original');fs.mkdirSync(runtime);
 const selection=path.join(root,'selection.json');fs.writeFileSync(selection,'{broken');
 const messages=[],requests=[],picks=[],answers=[];
 const dialog={showMessageBox:async options=>{messages.push(options);assert(answers.length,'unexpected message');return {response:answers.shift()};},
 showOpenDialog:async()=>{assert(picks.length,'unexpected picker');return picks.shift();}};
 const controller=new StartupRecovery({dialog,selection,project:root,request:async(method,params)=>{requests.push({method,params});return {accounts:[{name:'合成公众号'}],database_schema:19,database_target_schema:20};},restart:async()=>{throw Error('unexpected restart');}});
 return {root,runtime,selection,messages,requests,picks,answers,controller};
}
test('malformed selection becomes a recovery issue without replacing original pointer',()=>{
 const f=fixture(),r=resolveWorkspace({selection:f.selection,fallback:path.join(f.root,'default')});
 assert(r.error);assert.equal(r.firstRun,false);assert.equal(path.basename(r.runtime),'.ice-startup-recovery');
 assert.equal(fs.readFileSync(f.selection,'utf8'),'{broken');assert(!fs.existsSync(r.runtime));
});
test('incomplete selected workspace is never silently bootstrapped or created',()=>{
 const f=fixture(),missing=path.join(f.root,'offline');fs.writeFileSync(f.selection,JSON.stringify({runtime_root:missing}));
 const r=resolveWorkspace({selection:f.selection,fallback:path.join(f.root,'default')});
 assert.match(r.error.message,/不存在|不完整/);assert(!fs.existsSync(missing));
 assert.throws(()=>checkedRuntime('C:\\temp\\data'));assert.throws(()=>checkedRuntime('relative'));
 assert.throws(()=>checkedRuntime(path.parse(f.root).root));
 assert.equal(checkedRuntime(path.parse(f.root).root,{allowRoot:true}),path.parse(f.root).root);
});
test('explicit controlled runtime overrides a malformed selection; fresh selection survives the next launch',()=>{
 const f=fixture();assert.equal(resolveWorkspace({selection:f.selection,override:f.runtime,fallback:f.runtime}).error,null);
 publishWorkspace(f.selection,f.runtime,true);
 const r=resolveWorkspace({selection:f.selection,fallback:path.join(f.root,'default')});assert.equal(r.runtime,f.runtime);assert.equal(r.error,null);
});
test('cancelling a checked workspace selection leaves every source byte unchanged',async()=>{
 const f=fixture();f.answers.push(0,1,3);f.picks.push({canceled:false,filePaths:[f.runtime]});
 assert.equal(await f.controller.run(Error('checksum drift')),false);
 assert.deepEqual(f.requests.map(r=>r.method),['workspace.inspect']);
 assert.equal(fs.readFileSync(f.selection,'utf8'),'{broken');
 assert(f.messages[1].detail.includes('19 → 20'));
});
test('confirmed new workspace uses a unique empty child and requires no engine or model call',async()=>{
 const f=fixture();f.answers.push(1,0,1);f.picks.push({canceled:false,filePaths:[f.root]});
 assert.equal(await f.controller.run(Error('bad db')),true);
 const selected=JSON.parse(fs.readFileSync(f.selection));assert.equal(selected.fresh,true);
 assert.equal(path.dirname(selected.runtime_root),f.root);assert.deepEqual(fs.readdirSync(selected.runtime_root),[]);
 assert.deepEqual(f.requests,[]);
});
test('selection write failure keeps the created directory and retries only the switch',async t=>{
 const f=fixture(),rename=fs.renameSync;let attempts=0;
 t.mock.method(fs,'renameSync',(...args)=>{if(++attempts===1)throw Error('write denied');return rename(...args);});
 f.answers.push(1,0,3,1);f.picks.push({canceled:false,filePaths:[f.root]});
 await f.controller.run(Error('bad db'));
 assert.equal(attempts,2);assert.equal(f.requests.length,0);
 assert.equal(fs.readdirSync(f.root).filter(n=>n.startsWith('ice-workspace-')).length,1);
 assert.equal(fs.readdirSync(f.root).filter(n=>n.endsWith('.tmp')).length,0);
});
test('backup confirmation cancellation cannot restore or change the pointer',async()=>{
 const f=fixture();f.controller.request=f.controller.backups.request=async method=>{
  f.requests.push(method);return {package_hash:'hash',accounts:[{name:'合成号'}],files:4,app_version:'test',database_schema:19,database_target_schema:20};};
 f.answers.push(2,1,3);f.picks.push({canceled:false,filePaths:[path.join(f.root,'test.zip')]});
 await f.controller.run(Error('bad db'));
 assert.deepEqual(f.requests,['backup.inspect']);assert.equal(fs.readFileSync(f.selection,'utf8'),'{broken');
});
test('standalone helper returns protocol errors and kills only its owned timeout child',async()=>{
 const f=fixture();
 const errorCommand={file:process.execPath,args:['-e',`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({error:'synthetic refusal'}));process.exitCode=1;});`,'--']};
 await assert.rejects(recoveryRequest(errorCommand,repo,f.root,'workspace.inspect',{}),/synthetic refusal/);
 const neverCommand={file:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000);','--']};
 await assert.rejects(recoveryRequest(neverCommand,repo,f.root,'workspace.inspect',{}, {timeoutMs:150}),/超时/);
});
