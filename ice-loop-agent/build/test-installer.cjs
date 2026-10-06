/* Native Windows upgrade tests, confined to an independent NSIS product identity. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),area=process.argv.includes('--integration')?path.join('E:/ICE-Installer-Validation','run-'+Date.now()):path.join(root,'.test-tmp','installer-'+Date.now());
fs.mkdirSync(area,{recursive:true});
const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const electron=path.join(root,'desktop/node_modules/electron/dist/electron.exe');
const python=path.join(root,'dist/teaching-python/python.exe');
const owned=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run(file,args,env={},timeout=60000){
  return new Promise((resolve,reject)=>{
    // NSIS requires the final /D= argument to be unquoted, including paths with spaces.
    // These test installer executable paths have no spaces; other subprocesses keep normal quoting.
    const nsisDirectoryArgument=/^Installer-(Legacy|Validation)-/.test(path.basename(file))&&args.at(-1)?.startsWith('/D=');
    if(nsisDirectoryArgument)assert(!/\s/.test(file),'Place the test installer executable in a path without spaces');
    const child=spawn(file,args,{cwd:root,windowsHide:true,windowsVerbatimArguments:Boolean(nsisDirectoryArgument),env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
    const timer=setTimeout(()=>{child.kill();reject(Error('Timed out: '+file+' '+err));},timeout);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}
const ps=(file,args=[],env={})=>run(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],env);
async function waitFor(check,timeout=20000){const until=Date.now()+timeout;while(Date.now()<until){if(await check())return;await delay(200);}throw Error('Condition timed out');}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function fixture(name,recognized,hang){
  const folder=path.join(area,name);fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name:recognized?'ice-loop-studio':'unrelated-electron-fixture',main:'main.cjs'}));
  fs.writeFileSync(path.join(folder,'main.cjs'),`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const {spawn}=require('node:child_process');let window,child;const log=value=>fs.appendFileSync(${JSON.stringify(path.join(folder,'events.txt'))},value+'\\n');app.whenReady().then(async()=>{child=spawn(${JSON.stringify(python)},['-c','import time; time.sleep(120)'],{windowsHide:true,stdio:'ignore'});window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});window.on('close',()=>log('close'));${hang?"window.on('close',event=>event.preventDefault());":""}await window.loadURL('data:text/html,installer-fixture');fs.writeFileSync(${JSON.stringify(path.join(folder,'ready.json'))},JSON.stringify({main:process.pid,child:child.pid}));});app.on('before-quit',()=>{log('before-quit');${hang?'':'if(child)child.kill();'}});app.on('window-all-closed',()=>{log('window-all-closed');app.quit();});`);
  const child=spawn(electron,[folder],{cwd:root,windowsHide:true,stdio:'ignore'});owned.push(child.pid);
  await waitFor(()=>fs.existsSync(path.join(folder,'ready.json')));const result=JSON.parse(fs.readFileSync(path.join(folder,'ready.json')));owned.push(result.child);
  return result;
}
async function unit(){
  const foreign=await fixture('unrelated',false,false);
  const regular=await fixture('graceful',true,false);
  const first=await ps(path.join(root,'desktop/installer/stop-agent.ps1'),['-GraceSeconds','2','-ForceSeconds','5','-ReportPath',path.join(area,'graceful.json')]);
  assert.equal(first.code,0,first.err);const firstResult=JSON.parse(fs.readFileSync(path.join(area,'graceful.json')));
  assert(firstResult.discovered.includes(regular.main));assert(!firstResult.force_stopped.includes(regular.main),'WM_CLOSE should quit the normal hidden Electron window');
  assert(!alive(regular.main)&&!alive(regular.child));assert(alive(foreign.main)&&alive(foreign.child));
  const hung=await fixture('hung',true,true);
  const forced=await ps(path.join(root,'desktop/installer/stop-agent.ps1'),['-GraceSeconds','1','-ForceSeconds','5','-ReportPath',path.join(area,'forced.json')]);
  assert.equal(forced.code,0,forced.err);const forcedResult=JSON.parse(fs.readFileSync(path.join(area,'forced.json')));
  assert(forcedResult.force_stopped.includes(hung.main));assert(!alive(hung.main)&&!alive(hung.child));assert(alive(foreign.main)&&alive(foreign.child));
  const fakeAppData=path.join(area,'appdata');fs.mkdirSync(fakeAppData,{recursive:true});
  const install=path.join(area,'program'),workspace=path.join(install,'ICE-Workspace-test');fs.mkdirSync(workspace,{recursive:true});
  fs.writeFileSync(path.join(workspace,'app.db'),'test-database-bytes');fs.writeFileSync(path.join(workspace,'settings.json'),JSON.stringify({article_root:path.join(workspace,'articles')}));
  fs.mkdirSync(path.join(workspace,'articles'));fs.writeFileSync(path.join(workspace,'articles','article.md'),'# Keep my article\n');
  const original=sha(path.join(workspace,'articles','article.md')),stage=path.join(area,'stage.txt'),helper=path.join(root,'desktop/installer/preserve-workspaces.ps1');
  let r=await ps(helper,['-Mode','Stage','-InstallRoot',install,'-StageFile',stage],{APPDATA:fakeAppData});assert.equal(r.code,0,r.err);assert(!fs.existsSync(workspace));
  // Simulate the old NSIS recursive removal only after an exact test-area check.
  assert(path.resolve(install).startsWith(path.resolve(area)+path.sep));fs.rmSync(install,{recursive:true});fs.mkdirSync(install);
  r=await ps(helper,['-Mode','Restore','-StageFile',stage],{APPDATA:fakeAppData});assert.equal(r.code,0,r.err);assert.equal(sha(path.join(workspace,'articles','article.md')),original);
  r=await ps(helper,['-Mode','Restore','-StageFile',stage],{APPDATA:fakeAppData});assert.equal(r.code,0,r.err);
  // Existing destination never overwrites staged data, and explicit recovery succeeds later.
  const collisionStage=path.join(area,'collision-stage.txt');r=await ps(helper,['-Mode','Stage','-InstallRoot',install,'-StageFile',collisionStage],{APPDATA:fakeAppData});assert.equal(r.code,0,r.err);
  fs.mkdirSync(workspace);r=await ps(helper,['-Mode','Restore','-StageFile',collisionStage],{APPDATA:fakeAppData});assert.equal(r.code,22);
  fs.rmdirSync(workspace);r=await ps(helper,['-Mode','Restore','-StageFile',collisionStage],{APPDATA:fakeAppData});assert.equal(r.code,0,r.err);assert.equal(sha(path.join(workspace,'articles','article.md')),original);
  return {graceful:firstResult,forced:forcedResult,unrelated_processes_retained:true,workspace_bytes_retained:true,restore_idempotent:true,restore_conflict_preserves_data:true};
}
async function integration(){
  const install=path.join(area,'program'),old=path.join(area,'Installer-Legacy-1.1.0.exe'),updated=path.join(area,'Installer-Validation-1.1.1.exe');
  for(const file of [old,updated]){const source=path.join(root,'.test-tmp/installer-validation-package',path.basename(file));assert(fs.existsSync(source),'Missing test installer: '+source);fs.copyFileSync(source,file);}
  const installerEnv={TEMP:area,TMP:area};
  let r=await run(old,['/S','/currentuser','/D='+install],installerEnv,600000);assert.equal(r.code,0,r.err);
  const executable=path.join(install,'ICE Loop Studio.exe');assert(fs.existsSync(executable));
  const runtime=path.join(install,'ICE-Workspace-upgrade-test');fs.mkdirSync(runtime,{recursive:true});
  const testEnv={...process.env,ICE_DESKTOP_RUNTIME:runtime,PATH:path.join(process.env.SystemRoot,'System32')};delete testEnv.ICE_PYTHON;delete testEnv.PYTHONPATH;
  const child=spawn(executable,[],{cwd:install,windowsHide:true,env:testEnv,stdio:'ignore'});owned.push(child.pid);
  await waitFor(()=>fs.existsSync(path.join(runtime,'app.db'))&&fs.existsSync(path.join(runtime,'settings.json')));
  await delay(1500);assert(alive(child.pid));
  const sentinel=path.join(runtime,'my-article.md');fs.writeFileSync(sentinel,'# Preserve my article\n升级前真实文件\n');const hash=sha(sentinel);
  const foreign=await fixture('integration-unrelated',false,false);
  r=await run(updated,['/S','/currentuser','/D='+install],installerEnv,600000);assert.equal(r.code,0,r.err+' '+(fs.existsSync(path.join(area,'ICE-Loop-Install-Stop.json'))?fs.readFileSync(path.join(area,'ICE-Loop-Install-Stop.json'),'utf8'):'No stop report'));
  await waitFor(()=>!alive(child.pid));assert.equal(sha(sentinel),hash);assert(fs.existsSync(path.join(runtime,'app.db')));assert(alive(foreign.main)&&alive(foreign.child));
  assert.equal(sha(path.join(install,'resources/app.asar')),sha(path.join(root,'release/win-unpacked/resources/app.asar')));
  // Restart with the same real database, then test the no-longer-needed running-app shutdown.
  const restarted=spawn(executable,[],{cwd:install,windowsHide:true,env:testEnv,stdio:'ignore'});owned.push(restarted.pid);await delay(2500);assert(alive(restarted.pid));
  const stopped=await ps(path.join(root,'desktop/installer/stop-agent.ps1'),['-ReportPath',path.join(area,'after-upgrade.json')]);assert.equal(stopped.code,0,stopped.err);assert(!alive(restarted.pid));
  assert.equal(sha(sentinel),hash);
  const probe=await run(executable,['--provider-smoke'],testEnv,60000);assert.equal(probe.code,0,probe.err);
  const providerFile=path.join(runtime,'provider-smoke.json');assert(fs.existsSync(providerFile));
  const providerResult=JSON.parse(fs.readFileSync(providerFile));assert(providerResult.results.every(row=>row.status==='not_configured'));
  const result={silent_old_install:true,running_upgrade:true,old_main_stopped:true,workspace_original_path:runtime,workspace_bytes_retained:true,unrelated_processes_retained:true,restarted_with_original_database:true,bootstrap_with_original_database:true,paid_model_calls:false,installed_asar_matches_release:true,test_identity:'7419f5e9-6d04-4ef4-9c1b-d2e2c3de1581',actual_user_installation_untouched:true};
  // Leave no test registration: only the separate, verified test installer is uninstalled.
  const uninstaller=path.join(install,'Uninstall ICE Loop Studio.exe');assert(fs.existsSync(uninstaller));r=await run(uninstaller,['/S','/currentuser'],{},180000);assert.equal(r.code,0,r.err);result.test_uninstall_completed=true;
  r=await run(updated,['/S','/currentuser','/D='+install],installerEnv,600000);assert.equal(r.code,0,r.err);assert(fs.existsSync(executable));result.fresh_install_without_workspace=true;
  r=await run(uninstaller,['/S','/currentuser'],{},180000);assert.equal(r.code,0,r.err);
  return result;
}
(async()=>{try{const results=process.argv.includes('--integration')?await integration():await unit();fs.writeFileSync(path.join(area,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({area,...results},null,2));}finally{for(const pid of owned.reverse())if(alive(pid))try{process.kill(pid);}catch{}}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
