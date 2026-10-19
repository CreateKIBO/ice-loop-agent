'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {BackupActions}=require('../backup-actions.cjs');
const parent=path.resolve(__dirname,'../../.test-tmp');fs.mkdirSync(parent,{recursive:true});
const owned=fs.mkdtempSync(path.join(parent,'backup-actions-'));
test.after(()=>{assert.equal(path.dirname(fs.realpathSync(owned)),fs.realpathSync(parent));assert.equal(fs.lstatSync(owned).isSymbolicLink(),false);fs.rmSync(owned,{recursive:true,force:true});});
let sequence=0;
function fixture(){
 const root=path.join(owned,String(++sequence));fs.mkdirSync(root);
 const selection=path.join(root,'selected.json');fs.writeFileSync(selection,JSON.stringify({runtime_root:'original-runtime'}));
 const calls=[],state={now:1000,cancel:false};
 const dialog={showOpenDialog:async()=>({canceled:state.cancel,filePaths:[root]}),showSaveDialog:async()=>({canceled:state.cancel,filePath:path.join(root,'backup.zip')})};
 const request=async(method,params)=>{
  calls.push({method,params});
  if(method==='backup.restore'){
   const runtime=path.join(params.destination,'runtime');fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(runtime,'app.db'),'restored fixture bytes');
   return {runtime_root:runtime,destination:params.destination,accounts:[],reconnect_required:true};
  }
  return {package_hash:'reviewed-hash',database_checked:true};
 };
 const actions=new BackupActions({request,dialog,window:()=>null,project:root,selection,now:()=>state.now,ttlMs:10});
 return {root,selection,calls,state,dialog,actions};
}
test('cancelled save and inspection never call the engine',async()=>{
 const f=fixture();f.state.cancel=true;assert.equal(await f.actions.create(),null);assert.equal(await f.actions.inspect(),null);assert.deepEqual(f.calls,[]);
});
test('restoring needs the exact main process review token',async()=>{
 const f=fixture();await assert.rejects(f.actions.restore('arbitrary'),/先选择/);
 const review=await f.actions.inspect();await assert.rejects(f.actions.restore(review.token+'changed'),/先选择/);
 assert.equal(f.calls.length,1);
});
test('cancelled restore preserves review and current selection',async()=>{
 const f=fixture(),review=await f.actions.inspect();f.state.cancel=true;
 assert.equal(await f.actions.restore(review.token),null);
 assert.equal(JSON.parse(fs.readFileSync(f.selection)).runtime_root,'original-runtime');
 f.state.cancel=false;assert.equal((await f.actions.restore(review.token)).restart_required,true);
});
test('new cancelled preview invalidates the earlier review',async()=>{
 const f=fixture(),review=await f.actions.inspect();f.state.cancel=true;await f.actions.inspect();
 await assert.rejects(f.actions.restore(review.token),/先选择/);
});
test('review expires before opening a directory picker',async()=>{
 const f=fixture(),review=await f.actions.inspect();f.state.now=1010;
 await assert.rejects(f.actions.restore(review.token),/过期/);assert.equal(f.calls.length,1);
});
test('review expiring while native picker is open cannot restore',async()=>{
 const f=fixture(),review=await f.actions.inspect();f.dialog.showOpenDialog=async()=>{f.state.now=1010;return {canceled:false,filePaths:[f.root]};};
 await assert.rejects(f.actions.restore(review.token),/过期/);assert.equal(f.calls.length,1);
});
test('restore reuses reviewed hash, publishes selection atomically and consumes review',async()=>{
 const f=fixture(),review=await f.actions.inspect(),result=await f.actions.restore(review.token);
 assert.equal(result.restart_required,true);assert.equal(f.calls[1].params.package_hash,'reviewed-hash');
 assert.equal(path.dirname(result.destination),f.root);assert.equal(fs.existsSync(result.runtime_root),true);
 assert.equal(JSON.parse(fs.readFileSync(f.selection)).runtime_root,result.runtime_root);
 assert.equal(fs.readdirSync(f.root).filter(n=>n.endsWith('.tmp')).length,0);
 await assert.rejects(f.actions.restore(review.token),/先选择/);
});
test('selection write failure reports preserved restored data and can retry without restoring twice',async t=>{
 const f=fixture(),review=await f.actions.inspect();
 const rename=fs.renameSync;t.mock.method(fs,'renameSync',()=>{throw Error('fixture permission denied');});
 const result=await f.actions.restore(review.token);
 assert.equal(result.restart_required,false);assert.ok(result.activation_token);assert.match(result.selection_error,/资料已恢复/);
 assert.equal(fs.existsSync(path.join(result.runtime_root,'app.db')),true);
 assert.equal(JSON.parse(fs.readFileSync(f.selection)).runtime_root,'original-runtime');
 assert.equal(fs.readdirSync(f.root).filter(n=>n.endsWith('.tmp')).length,0);
 await assert.rejects(f.actions.activate('foreign-token'),/失效/);
 fs.renameSync=rename;
 const retry=await f.actions.activate(result.activation_token);
 assert.equal(retry.runtime_root,result.runtime_root);assert.equal(retry.restart_required,true);
 assert.equal(f.calls.filter(c=>c.method==='backup.restore').length,1);
 await assert.rejects(f.actions.activate(result.activation_token),/失效/);
});
test('concurrent operations cannot issue a second picker or restore',async()=>{
 const f=fixture();let finish;
 f.dialog.showOpenDialog=()=>new Promise(resolve=>{finish=resolve;});
 const first=f.actions.inspect();await assert.rejects(f.actions.inspect(),/正在处理/);
 await assert.rejects(f.actions.create(),/正在处理/);
 finish({canceled:true});assert.equal(await first,null);assert.equal(f.actions.busy,false);
});
test('engine failure leaves the selection and releases the operation barrier',async()=>{
 const f=fixture(),review=await f.actions.inspect();f.actions.request=async()=>{throw Error('备份包已变化');};
 await assert.rejects(f.actions.restore(review.token),/已变化/);assert.equal(f.actions.busy,false);
 assert.equal(JSON.parse(fs.readFileSync(f.selection)).runtime_root,'original-runtime');
 await assert.rejects(f.actions.restore(review.token),/先选择/);
});
test('distribution includes backup bridge; raw path restore remains outside renderer request allowlist',()=>{
 const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../electron-builder.json'),'utf8'));
 assert.ok(config.files.includes('backup-actions.cjs'));
 const methods=require('../workbench-methods.cjs');assert.ok(methods.includes('backup.queue'));assert.ok(methods.includes('backup.resume_queue'));
 assert.ok(!methods.includes('backup.restore'));assert.ok(!methods.includes('backup.create'));
});
