"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const {StartupProgress}=require('../startup-progress.cjs');
const {BackupActions}=require('../backup-actions.cjs');
const repo=path.resolve(__dirname,'../..');
function fixture(){
 const root=fs.mkdtempSync(path.join(repo,'.test-tmp/recovery-ui-'));const handlers=new Map();let cancelled=0;
 class View extends EventEmitter{
   constructor(options){super();this.options=options;this.destroyed=false;this.webContents=new EventEmitter();this.webContents.send=(channel,value)=>{this.last={channel,value};};this.webContents.setWindowOpenHandler=()=>{};}
   async loadURL(url){this.url=url;}show(){this.shown=true;}isDestroyed(){return this.destroyed;}destroy(){this.destroyed=true;}
 }
 const ipcMain={handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)};
 const progress=new StartupProgress({BrowserWindow:View,ipcMain,runtime:root,preload:'preload',onCancel:()=>cancelled++});
 return {root,progress,handlers,cancelled:()=>cancelled};
}
test('startup receives only bounded known phase data and cancel stops before upgrade',async()=>{
 const f=fixture();try{
   await f.progress.show();const view=f.progress.view;
   assert.equal(view.options.webPreferences.sandbox,true);assert.equal(view.options.webPreferences.nodeIntegration,false);
   const event={sender:view.webContents,senderFrame:{url:'ice://app/ui/index.html?startup=1'}};
   assert.throws(()=>f.handlers.get('ice:startup-state')({sender:{},senderFrame:event.senderFrame}),/无效/);
   assert.equal(f.progress.accept({kind:'startup.progress',phase:'unknown'}),false);
   assert.equal(f.progress.accept({kind:'startup.progress',phase:'copy_files',cancelable:true,bytes_done:13,files_done:NaN,content:'private'}),true);
   assert.equal(view.last.value.bytes_done,13);assert.equal(view.last.value.content,undefined);assert.equal(view.last.value.files_done,undefined);
   assert.equal(f.handlers.get('ice:startup-cancel')(event).cancelled,true);
   assert.equal(f.cancelled(),1);assert.equal(fs.existsSync(f.progress.cancelFile),true);
   f.progress.cancel();assert.equal(f.cancelled(),1);
 }finally{const view=f.progress.view;f.progress.end();assert.equal(view.isDestroyed(),true);assert.equal(f.handlers.size,0);assert.equal(fs.existsSync(f.progress.cancelFile),false);}
});
test('migration stage refuses close cancellation; end destroys splash without cancelling',async()=>{
 const f=fixture();try{
   await f.progress.show();f.progress.accept({kind:'startup.progress',phase:'upgrade_database',cancelable:false});
   let prevented=false;f.progress.view.emit('close',{preventDefault:()=>prevented=true});
   assert.equal(prevented,true);assert.equal(f.cancelled(),0);assert.equal(fs.existsSync(f.progress.cancelFile),false);
 }finally{f.progress.end();}assert.equal(f.cancelled(),0);
});
test('recovery point preview grants only id and reviewed hash, raw paths remain private',async()=>{
 const f=fixture();f.progress.end();const calls=[];
 const a=new BackupActions({request:async(method,params)=>{calls.push({method,params});return method==='recovery.restore'?{runtime_root:path.join(f.root,'restored')}:{package_hash:'verified'};},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[f.root]})},window:()=>null,project:repo,selection:path.join(f.root,'selection.json')});
 await assert.rejects(a.inspectPoint('../escape'),/标识/);
 const summary=await a.inspectPoint('a'.repeat(32));await a.restore(summary.token);
 assert.equal(calls[0].method,'recovery.inspect');assert.equal(calls[1].method,'recovery.restore');assert.equal(calls[1].params.point_id,'a'.repeat(32));
 assert.equal(calls[1].params.package_hash,'verified');assert.equal(calls[1].params.file_path,undefined);
 const methods=require('../workbench-methods.cjs');for(const privateMethod of ['recovery.restore','recovery.inspect','recovery.delete'])assert.equal(methods.includes(privateMethod),false);
 assert.equal(methods.includes('recovery.list'),true);assert.equal(methods.includes('recovery.create'),true);
 const config=require('../electron-builder.json');assert.equal(config.files.includes('startup-progress.cjs'),true);
});
