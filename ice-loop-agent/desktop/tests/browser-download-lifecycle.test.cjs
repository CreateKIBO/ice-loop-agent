const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
  const handlers=new Map(),sessions=new Map(),dialogs=[],requests=[],events=[],items=[];
  let account='account-a',stageResolve,deferBootstrap=false,bootstrapResolve;
  const win={isDestroyed:()=>false,getContentSize:()=>[1100,800],contentView:{addChildView(){},removeChildView(){}},webContents:{send:(name,payload)=>events.push({name,payload})}};
  class View{constructor({webPreferences:{session}}){const wc=this.webContents=new EventEmitter();wc.session=session;wc.dead=false;wc.isDestroyed=()=>wc.dead;wc.close=()=>{wc.dead=true;};wc.getURL=()=> 'https://fixture.example/';wc.getTitle=()=> 'fixture';wc.isLoading=()=>false;wc.navigationHistory={canGoBack:()=>false,canGoForward:()=>false};wc.setWindowOpenHandler=()=>{};wc.loadURL=async()=>{};}setBounds(){}}
  const electron={WebContentsView:View,BrowserWindow:{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showSaveDialog:()=>new Promise(resolve=>dialogs.push(resolve))},session:{fromPartition:key=>{if(!sessions.has(key)){const s=new EventEmitter();s.setPermissionRequestHandler=()=>{};s.setPermissionCheckHandler=()=>{};sessions.set(key,s);}return sessions.get(key);}}};
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../browser.cjs'),'utf8'),{module:mod,exports:mod.exports,require:name=>name==='electron'?electron:name==='node:fs'?{mkdirSync(){}}:require(name),console});
  const controller=mod.exports.installBrowser({window:()=>win,assertSender(){},runtime:path.join(__dirname,'../../.test-tmp/browser-unit'),request:async(method,params)=>{
    if(method==='bootstrap'){if(deferBootstrap){deferBootstrap=false;return await new Promise(resolve=>{bootstrapResolve=resolve;});}return {account:{id:account}};}
    requests.push({method,params});return await new Promise(resolve=>{stageResolve=resolve;});
  }});
  const invoke=(name,...args)=>handlers.get(name)({},...args);
  async function show(site='tapnow'){await invoke('ice:browser-show',{site,bounds:{x:100,y:160,width:900,height:600}});return controller.testPage();}
  function download(page){const item=new EventEmitter();item.cancelled=0;item.resumed=0;item.getSavePath=()=> 'E:/user-selected.png';item.setSaveDialogOptions=options=>{item.options=options;};item.getFilename=()=> 'image.png';item.getURL=()=> 'https://fixture.example/image.png';item.pause=()=>{};item.resume=()=>item.resumed++;item.cancel=()=>{item.cancelled++;item.emit('done',{},'cancelled');};page.session.emit('will-download',{},item,page.view.webContents);items.push(item);return item;}
  return {controller,show,download,invoke,dialogs,requests,events,sessions,deferBootstrap:()=>{deferBootstrap=true;},resolveBootstrap:id=>bootstrapResolve({account:{id}}),setAccount:v=>{account=v;},finishStage:()=>stageResolve({download_id:'download-a'})};
}
test('closing a webpage cancels its pending download and releases session download listeners',async()=>{
  const h=harness(),page=await h.show(),item=h.download(page);await tick();
  await h.invoke('ice:browser-command','close');
  assert.equal(item.cancelled,1,'close cancels the download before destroying the page');
  assert.equal(page.session.listenerCount('will-download'),0,'no retained page/controller closure after release');
  await tick();
  assert.equal(item.resumed,0,'no asynchronous save-path rewrite after page release');assert.equal(h.requests.length,0);
  assert.equal(page.view.webContents.isDestroyed(),true);
});
test('reset while awaiting native save/download never attributes A download to B',async()=>{
  const h=harness(),page=await h.show(),item=h.download(page);await tick();h.setAccount('account-b');h.controller.reset();
  await tick();
  assert.equal(item.cancelled,1);assert.equal(item.resumed,0);assert.equal(h.requests.length,0);assert.equal(page.session.listenerCount('will-download'),0);
});
test('completion keeps immutable source account and late receipt does not leak to new account',async()=>{
  const h=harness(),page=await h.show(),item=h.download(page);await tick();await tick();
  assert.ok(item.options.defaultPath.endsWith('image.png'));assert.equal(item.resumed,0);h.setAccount('account-b');item.emit('done',{},'completed');await tick();
  assert.equal(h.requests[0].params.account_id,'account-a','request must retain download origin even before UI reset');
  h.controller.reset();await h.show();const start=h.events.length;h.finishStage();await tick();
  assert.equal(h.events.slice(start).some(e=>e.payload.download_id==='download-a'),false,'no old-account path or receipt is emitted into B');
});
test('reopening the same persistent partition installs exactly one download listener',async()=>{
  const h=harness();let previous;
  for(let i=0;i<12;i++){const page=await h.show();if(previous)assert.equal(page.session,previous,'login partition survives page close');assert.equal(page.session.listenerCount('will-download'),1);await h.invoke('ice:browser-command','close');assert.equal(page.session.listenerCount('will-download'),0);previous=page.session;}
});

test('hiding for an overlay retains the same download; capacity is released after termination',async()=>{
  const h=harness(),page=await h.show();const items=Array.from({length:4},()=>h.download(page));
  const rejected=h.download(page);assert.equal(rejected.cancelled,1,'bounded simultaneous downloads');
  h.controller.hide();assert.ok(items.every(item=>item.cancelled===0),'modal hiding must not cancel active downloads');
  items[0].emit('done',{},'interrupted');const admitted=h.download(page);assert.equal(admitted.cancelled,0,'terminal item releases admission slot');
  h.controller.reset();assert.ok(items.slice(1).every(item=>item.cancelled===1));assert.equal(admitted.cancelled,1);
});

test('a delayed close command cannot destroy a newer publication webpage',async()=>{
  const h=harness(),old=await h.show();h.deferBootstrap();const closing=h.invoke('ice:browser-command','close');await tick();
  h.controller.reset();h.setAccount('account-b');const current=await h.show();h.resolveBootstrap('account-a');
  const result=await closing;assert.equal(result.cancelled,true);assert.equal(old.view.webContents.isDestroyed(),true);assert.equal(current.view.webContents.isDestroyed(),false);assert.equal(h.controller.state().account_id,'account-b');
});

test('release-all closes both sites and cancels every download without clearing session storage',async()=>{
 const h=harness(),tapnow=await h.show(),a=h.download(tapnow),wechat=await h.show('wechat'),b=h.download(wechat);
 assert.equal(h.controller.state().openCount,2);await h.invoke('ice:browser-command','close-all');
 assert.equal(tapnow.view.webContents.isDestroyed(),true);assert.equal(wechat.view.webContents.isDestroyed(),true);
 assert.equal(a.cancelled,1);assert.equal(b.cancelled,1);assert.equal(tapnow.session.listenerCount('will-download'),0);assert.equal(wechat.session.listenerCount('will-download'),0);
 assert.equal(h.controller.state().openCount,0);const reopened=await h.show();assert.equal(reopened.session,tapnow.session);
});
test('a delayed release-all cannot close a newly switched publication',async()=>{
 const h=harness(),old=await h.show();h.deferBootstrap();const closing=h.invoke('ice:browser-command','close-all');await tick();
 h.controller.reset();h.setAccount('account-b');const current=await h.show();h.resolveBootstrap('account-a');
 assert.equal((await closing).cancelled,true);assert.equal(current.view.webContents.isDestroyed(),false);assert.equal(old.view.webContents.isDestroyed(),true);
});
