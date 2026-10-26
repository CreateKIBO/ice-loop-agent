// Offline real Chromium DownloadItem + real Python DesktopService. Own new runtime only.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'.test-tmp/browser-download-native',crypto.randomUUID()),runtime=path.join(root,'runtime');
fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(root,'.test-owner.json'),JSON.stringify({purpose:'offline real browser download lifecycle'}));
process.env.TEMP=process.env.TMP=runtime;
app.setPath('userData',path.join(runtime,'user-data'));app.setPath('sessionData',path.join(runtime,'session-data'));app.setPath('crashDumps',path.join(runtime,'crashes'));app.setAppLogsPath(path.join(runtime,'logs'));app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.on('window-all-closed',()=>{});
app.on('session-created',ses=>ses.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true})));
const result={state:'running',runtime,root,scope:'source Chromium actual DownloadItem; real Python JSON-lines RPC; local HTTPS protocol fixtures; native save destination injected synchronously; OS dialog not exercised',checks:{},samples:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await wait(40);}throw Error('Timeout: '+label);}
const check=(key,value)=>{assert.ok(value,key);result.checks[key]=true;};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/A8AAAAASUVORK5CYII=','base64');
let child,owner,controller,seq=0,closed=false;const pending=new Map(),requests=[],receipts=[],items=[],bodies=[];let destination=null;let delayStage=false,releaseStage=null;
async function rpc(method,params={}){requests.push({method,params});const id=++seq;return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},30000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
async function request(method,params){if(method==='downloads.stage'&&delayStage){await new Promise(resolve=>{releaseStage=resolve;});}return rpc(method,params);}
function sample(label){const ownedTree=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'sample-owned-memory.ps1'),'-RootProcessId',String(process.pid)],{encoding:'utf8',windowsHide:true}));result.samples.push({label,owned_tree:ownedTree,processes:app.getAppMetrics().map(({pid,type,memory})=>({pid,type,memory})),web_contents:require('electron').webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType()}))});}
const invoke=(channel,...args)=>owner.webContents.executeJavaScript('window.browserTest.invoke('+[channel,...args].map(JSON.stringify).join(',')+')');
async function open(){await invoke('ice:browser-show',{site:'tapnow',bounds:{x:100,y:160,width:800,height:520}});const page=controller.testPage();page.view.webContents.stop();return page;}
function configure(page){if(page.session.__offlineConfigured)return;page.session.__offlineConfigured=true;
  page.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>cb({cancel:new URL(d.url).hostname!=='download-fixture.example'}));
  page.session.protocol.handle('https',req=>new Response(new ReadableStream({start(stream){stream.enqueue(png.subarray(0,8));bodies.push(stream);}}),{headers:{'content-type':'image/png','content-length':String(png.length),'content-disposition':'attachment; filename="picture.png"'}}));
  page.session.prependListener('will-download',(_e,item)=>{item.setSavePath(destination);items.push(item);});
}
async function begin(page,name){destination=path.join(root,name);const start=items.length;page.view.webContents.downloadURL('https://download-fixture.example/'+crypto.randomUUID()+'.png');await until(()=>items.length>start&&bodies.length,'real controlled-stream download');return items.at(-1);}
async function main(){
 const env={...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'};for(const name of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'])delete env[name];
 child=spawn(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-m','ice_agent.desktop_service','--project-root',repo,'--runtime-root',runtime,'--article-root',path.join(root,'articles')],{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.once('exit',()=>{closed=true;for(const p of pending.values())p.reject(Error('Engine exited'));pending.clear();});
 child.stderr.pipe(fs.createWriteStream(path.join(root,'engine.log')));
 readline.createInterface({input:child.stdout}).on('line',line=>{const msg=JSON.parse(line),p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);});
 const first=(await rpc('bootstrap')).account,accountA=first.id;const other={...first,name:'Native Download B',preset:'general',article_root:path.join(root,'b-articles'),library_root:''};delete other.id;
 const accountB=(await rpc('accounts.save',{account:other})).saved_account_id;await rpc('accounts.switch',{account_id:accountA});result.accounts={a:accountA,b:accountB};
 owner=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{preload:path.join(__dirname,'browser-download-native-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 controller=require('../browser.cjs').installBrowser({window:()=>owner,assertSender:event=>assert.equal(event.sender,owner.webContents),request,runtime});
 const originalSend=owner.webContents.send.bind(owner.webContents);owner.webContents.send=(name,payload)=>{if(name==='ice:browser-state')receipts.push(payload);originalSend(name,payload);};
 await owner.loadURL('data:text/html,<title>Owned offline download test</title><p>local host</p>');
 let page=await open();configure(page);sample('initial');
 // DownloadItem is real; only the operating-system dialog choice is controlled.
 const oldContents=page.view.webContents;let item=await begin(page,'cancelled-a.png');await rpc('accounts.switch',{account_id:accountB});controller.reset();
 bodies.shift();await wait(150);
 check('switch_cancels_pending_download',item.getState()==='cancelled');check('cancelled_download_creates_no_final_file',!fs.existsSync(path.join(root,'cancelled-a.png')));check('switch_has_no_stage_write',!requests.some(r=>r.method==='downloads.stage'));
 check('old_contents_destroyed',oldContents.isDestroyed());
 await rpc('accounts.switch',{account_id:accountA});page=await open();configure(page);delayStage=true;
 item=await begin(page,'completed-a.png');const completed=destination;{const stream=bodies.shift();stream.enqueue(png.subarray(8));stream.close();}
 await until(()=>releaseStage!==null,'completed download awaiting archive');check('real_download_saved_exact_bytes',fs.readFileSync(completed).equals(png));
 await rpc('accounts.switch',{account_id:accountB});controller.reset();await open();const receiptStart=receipts.length;releaseStage();delayStage=false;
 await until(()=>requests.some(r=>r.method==='downloads.stage'),'archive request');await until(async()=>{await rpc('accounts.switch',{account_id:accountA});return (await rpc('downloads.list')).downloads.length===1;},'archive in source account');
 const sourceRows=(await rpc('downloads.list')).downloads;check('archive_source_account_exact',sourceRows.length===1&&sourceRows[0].file_path===completed);await rpc('accounts.switch',{account_id:accountB});check('other_account_has_no_downloads',(await rpc('downloads.list')).downloads.length===0);
 check('no_late_receipt_or_path_in_new_account',!receipts.slice(receiptStart).some(r=>r.download_file===completed));check('stage_explicit_source_account',requests.find(r=>r.method==='downloads.stage').params.account_id===accountA);
 await rpc('accounts.switch',{account_id:accountA});controller.reset();page=await open();configure(page);
 item=await begin(page,'closed.png');await invoke('ice:browser-command','close');bodies.shift();await wait(100);
 check('close_cancels_pending_real_download',item.getState()==='cancelled');check('close_preserves_completed_file',fs.readFileSync(completed).equals(png));check('close_leaves_no_closed_file',!fs.existsSync(path.join(root,'closed.png')));
 // Repeated release removes controller listeners while preserving partition cookies.
 let ses=page.session;const baselineListeners=ses.listenerCount('will-download');await ses.cookies.set({url:'https://download-fixture.example',name:'owned-login',value:'preserved',expirationDate:Math.floor(Date.now()/1000)+3600});
 for(let n=0;n<16;n++){page=await open();configure(page);const contents=page.view.webContents;await invoke('ice:browser-command','close');check('released_contents_'+n,contents.isDestroyed());assert.equal(ses.listenerCount('will-download'),baselineListeners);if(n%4===3)sample('released-'+(n+1));}
 check('listener_count_stable_after_16_cycles',ses.listenerCount('will-download')===baselineListeners);check('login_cookie_preserved',(await ses.cookies.get({name:'owned-login'})).length===1);
 const leftovers=[];function scan(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(e.isDirectory())scan(full);else if(/\.crdownload$|^\.pending-/.test(e.name))leftovers.push(full);}}scan(root);check('no_pending_download_files',leftovers.length===0);
 check('only_host_webcontents_remains',require('electron').webContents.getAllWebContents().length===1);result.state='passed';
}
app.whenReady().then(main).catch(error=>{result.state='failed';result.error=error.stack;fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify(result,null,2));process.exitCode=1;}).finally(async()=>{
 try{controller?.reset();if(owner&&!owner.isDestroyed())owner.destroy();if(child&&!closed){child.stdin.end();await Promise.race([new Promise(r=>child.once('exit',r)),wait(5000)]);if(!closed)child.kill();}result.engine_exited=closed;result.check_count=Object.keys(result.checks).length;fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,state:result.state,checks:result.check_count,error:result.error}));}finally{app.exit(result.state==='passed'?0:1);}
});
