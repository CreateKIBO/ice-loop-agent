// Actual NSIS tests: unique product identity, E-only generated paths, no user install.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process'),net=require('node:net');
const repo=path.resolve(__dirname,'..'),desktop=path.join(repo,'desktop'),candidate=path.resolve(process.argv[2]||'');
const baseline=process.argv.includes('--baseline'),legacyUpgrade=process.argv.includes('--legacy-upgrade');
assert(candidate.startsWith(path.join(repo,'.test-tmp/candidates')+path.sep));
const meta=JSON.parse(fs.readFileSync(path.join(candidate,'CANDIDATE.json'),'utf8'));
assert.equal(meta.project,repo);assert.equal(meta.state,'built');assert.equal(JSON.parse(fs.readFileSync(path.join(candidate,'payload-audit.json'))).state,'passed');
const root=path.join(repo,'.test-tmp/installer-validation',crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
const guid=crypto.randomUUID(),appId='media.iceloop.validation.'+guid.replaceAll('-','');
const result={state:'running',root,candidate,baseline,legacy_upgrade:legacyUpgrade,app_id:appId,guid,checks:{},steps:[],project:repo,installed:false,uninstalled:false};
const save=()=>fs.writeFileSync(path.join(root,'INSTALLER-VALIDATION.json'),JSON.stringify(result,null,2));result.owner_pid=process.pid;save();
process.on('beforeExit',()=>{if(result.state!=='passed'&&result.state!=='reproduced-user-file-loss')process.exitCode=1;if(result.state==='running'){result.state='failed';result.error='Driver ended before its async operation completed';save();console.error(JSON.stringify({state:result.state,root}));process.exitCode=1;}});
process.on('exit',()=>{if((result.state!=='passed'&&result.state!=='reproduced-user-file-loss')||result.cleanup_error)process.exitCode=1;});
for(const name of ['temp','cache','output','sources','appdata'])fs.mkdirSync(path.join(root,name));
const env={...process.env,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),APPDATA:path.join(root,'appdata'),ELECTRON_BUILDER_CACHE:path.join(root,'cache'),CSC_IDENTITY_AUTO_DISCOVERY:'false',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'};
for(const name of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY','ICE_PYTHON','ICE_TEACHING_PYTHON','PYTHONPATH','VIRTUAL_ENV','NODE_PATH','CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','GH_TOKEN','GITHUB_TOKEN'])delete env[name];
const sha=p=>{const fd=fs.openSync(p,'r'),buffer=Buffer.allocUnsafe(1024*1024),hash=crypto.createHash('sha256');try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest('hex');}finally{fs.closeSync(fd);}};
const check=(name,value)=>{assert(value,name);result.checks[name]=true;save();};
async function run(name,file,args,{input,verbatim=false,timeout=180000,expected=0}={}){
 const log=path.join(root,name+'.log'),fd=fs.openSync(log,'w'),start=Date.now();
 const code=await new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:repo,env,windowsHide:true,windowsVerbatimArguments:verbatim,stdio:[input===undefined?'ignore':'pipe',fd,fd]});
 result.current_pid=child.pid;save();let timed=false;const timer=setTimeout(()=>{timed=true;child.kill();},timeout);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',c=>{clearTimeout(timer);timed?reject(Error(name+' timed out')):resolve(c);});if(input!==undefined)child.stdin.end(input);});
 fs.closeSync(fd);delete result.current_pid;result.steps.push({name,exit_code:code,elapsed_ms:Date.now()-start,log});save();assert.equal(code,expected,name+' failed; '+log);return log;
}
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const packaged=path.join(root,'prepackaged');
const install=path.join(root,'program with spaces'),exe=path.join(install,'ICE Loop Studio.exe'),uninstaller=path.join(install,'Uninstall ICE Loop Studio.exe');
const sessions=[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(150);}throw Error('Timed out waiting for observed state');}
async function startApp(file,runtime){
 fs.mkdirSync(runtime,{recursive:true});
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const fd=fs.openSync(path.join(runtime,'electron-test.log'),'w');
 const child=spawn(file,['--new-ui','--startup-diagnostics','--remote-debugging-port='+port],{cwd:path.dirname(file),env:{...env,ICE_DESKTOP_RUNTIME:runtime,PATH:path.join(process.env.SystemRoot,'System32')},windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
 const session={child,file,runtime,pending:new Map(),sequence:0};sessions.push(session);
 let target;await until(async()=>{if(!alive(child.pid))throw Error('Installed app exited before UI');try{target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.url==='ice://app/ui/index.html');return !!target;}catch{return false;}});
 const ws=session.ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('error',()=>{});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const q=session.pending.get(m.id);if(q){session.pending.delete(m.id);clearTimeout(q.timer);m.error?q.reject(Error(JSON.stringify(m.error))):q.resolve(m.result);}}});
 session.call=(method,params={})=>new Promise((resolve,reject)=>{const id=++session.sequence,timer=setTimeout(()=>{session.pending.delete(id);reject(Error('CDP '+method+' timed out'));},15000);session.pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 session.evaluate=async expression=>{const r=await session.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 session.rpc=(method,params={})=>session.evaluate('window.ice.request('+JSON.stringify(method)+','+JSON.stringify(params)+')');
 await until(()=>session.evaluate("typeof window.ice?.request==='function'"));
 session.boot=await session.rpc('bootstrap');return session;
}
async function closeSession(session){
 try{if(session.ws?.readyState===1&&alive(session.child.pid))await session.call('Page.close');}catch{}
 if(alive(session.child.pid))await until(()=>!alive(session.child.pid),10000);
 session.ws?.close();
}
async function stopOwn(){for(const session of sessions)await closeSession(session);}
function registryPresent(){
 const code="$found=@();foreach($v in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$v);foreach($n in @('Software\\"+guid+"','Software\\"+guid+".Upgrade','Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+guid+"')){$k=$b.OpenSubKey($n);if($k){$found+=$n;$k.Dispose()}};$b.Dispose()};ConvertTo-Json -InputObject @($found) -Compress";
 const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',code],{env,windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).length>0;
}
async function uninstall(name){
 const copied=path.join(root,name+'-uninstaller.exe');assert(uninstaller.startsWith(root+path.sep));fs.copyFileSync(uninstaller,copied);assert.equal(sha(copied),sha(uninstaller));
 // _?= keeps the actual uninstaller in this process, just as builder's upgrade does.
 await run(name,copied,['/S','/currentuser','_?='+install],{verbatim:true,timeout:180000});
 await until(()=>!registryPresent());result.uninstalled=true;save();
}
(async()=>{try{
 // Snapshot helpers so a concurrent source change cannot alter a compiled test installer.
 fs.cpSync(path.join(candidate,'release/win-unpacked'),packaged,{recursive:true});
 fs.cpSync(path.join(desktop,'installer'),path.join(root,'sources'),{recursive:true});
 fs.cpSync(path.join(candidate,'cache/builder/nsis'),path.join(root,'cache/nsis'),{recursive:true});
 const {build,Platform,Arch}=require('../desktop/node_modules/electron-builder');
 const {createScript,installTemplateHook}=require('./nsis-upgrade-template.cjs');
 let activeScript;installTemplateHook(()=>activeScript);
 Object.assign(process.env,env);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
 const config=JSON.parse(fs.readFileSync(path.join(desktop,'electron-builder.json')));
 config.appId=appId;config.directories={...config.directories,output:path.join(root,'output')};
 config.nsis={...config.nsis,guid,include:path.join(root,'sources/installer.nsh'),allowElevation:false,createDesktopShortcut:false,createStartMenuShortcut:false,runAfterFinish:false,deleteAppDataOnUninstall:false,artifactName:'Validation-Setup.exe'};
 delete config.afterPack;delete config.afterSign;
 const safeScript=createScript(path.join(root,'nsis-template'),{installerCache:path.join(root,'cached-test-installer.exe')});
 if(!baseline){fs.copyFileSync(path.join(candidate,'release/install-files.json'),path.join(root,'output/install-files.json'));
  const include=path.join(root,'sources/installer.nsh');fs.writeFileSync(include,'!define ICE_INSTALL_FILE_MANIFEST "'+path.join(root,'output/install-files.json')+'"\n'+fs.readFileSync(include,'utf8'));}
 let initialSetup,failureSetup;
 if(legacyUpgrade){
  const oldSources=path.join(root,'legacy-sources');fs.mkdirSync(oldSources);fs.copyFileSync(path.join(root,'sources/stop-agent.ps1'),path.join(oldSources,'stop-agent.ps1'));
  const fixture=path.join(desktop,'tests/fixtures/legacy-installer.nsh'),witness=path.join(root,'legacy-uninstaller-invoked.txt');
  result.legacy_fixture_sha256=sha(fixture);result.legacy_witness=witness;
  const include=path.join(oldSources,'installer.nsh');fs.writeFileSync(include,'!define ICE_LEGACY_WITNESS "'+witness+'"\n'+fs.readFileSync(fixture,'utf8'));
  const oldConfig={...config,directories:{...config.directories,output:path.join(root,'legacy-output')},nsis:{...config.nsis,include,artifactName:'Legacy-Setup.exe'}};
  activeScript=createScript(path.join(root,'legacy-template'),{legacyFixture:true,installerCache:path.join(root,'cached-legacy-installer.exe')});
  await build({projectDir:desktop,prepackaged:packaged,publish:'never',targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),config:oldConfig});
  initialSetup=path.join(root,'legacy-output/Legacy-Setup.exe');result.legacy_setup_sha256=sha(initialSetup);save();
 }
 activeScript=safeScript;
 await build({projectDir:desktop,prepackaged:packaged,publish:'never',targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),config});
 if(legacyUpgrade){
  const faultDir=path.join(root,'failure-template');
  const script=createScript(faultDir,{installerCache:path.join(root,'cached-failure-installer.exe')});
  const file=path.join(faultDir,'extract-app.nsh'),body=fs.readFileSync(file,'utf8'),anchor='    ${If} $R0 != "success"';
  assert.equal(body.split(anchor).length,2);
  // Exercise the actual error branch after real extraction; never change production templates.
  fs.writeFileSync(file,body.replace(anchor,'    StrCpy $R0 "injected extraction failure"\n'+anchor));
  const failedConfig={...config,directories:{...config.directories,output:path.join(root,'failure-output')},nsis:{...config.nsis,artifactName:'Failure-Setup.exe'}};
  activeScript=script;
  await build({projectDir:desktop,prepackaged:packaged,publish:'never',targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),config:failedConfig});
  failureSetup=path.join(root,'failure-output/Failure-Setup.exe');result.failure_setup_sha256=sha(failureSetup);save();
 }
 const setup=path.join(root,'output/Validation-Setup.exe');assert(fs.statSync(setup).size>100000000);result.setup_sha256=sha(setup);save();
 await run('fresh-install',initialSetup||setup,['/S','/currentuser','/D='+install],{timeout:600000});result.installed=true;result.installation_generation=legacyUpgrade?'legacy':'current';check('installed_exe_matches_audited_candidate',sha(exe)===sha(path.join(candidate,'release/win-unpacked/ICE Loop Studio.exe')));
 if(baseline){
  const keep=path.join(install,'my-articles','do-not-delete.md');fs.mkdirSync(path.dirname(keep));fs.writeFileSync(keep,'# User article\nNever part of this program.\n');
  await uninstall('baseline-uninstall');
  result.user_file_preserved=fs.existsSync(keep);result.state=result.user_file_preserved?'unexpected-pass':'reproduced-user-file-loss';save();console.log(JSON.stringify({state:result.state,root}));return;
 }
 check('registered_test_identity',registryPresent());
 const runtime=path.join(install,'ICE-Workspace-validation');
 let app=await startApp(exe,runtime);
 check('installed_frozen_engine_boots',app.boot.version===meta.version&&app.boot.runtime_root===runtime);
 check('installed_app_has_no_cloud_credentials',app.boot.settings.profiles.every(row=>!row.has_key));
 const conversation=(await app.rpc('chat.create',{title:'Installer persistence acceptance'})).conversation.id;
 const keepFiles=['my-articles/my-article.md','resources/my-illustration.svg','ICE-Workspace-validation/articles/source.md'];
 const hashes={};for(const name of keepFiles){const file=path.join(install,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'User data retained: '+name+'\n');hashes[name]=sha(file);}
 let original=app.child.pid;
 const foreign=await startApp(path.join(candidate,'release/win-unpacked/ICE Loop Studio.exe'),path.join(root,'other-installation-runtime'));
 const foreignId=foreign.child.pid;const firstStop=path.join(root,'temp/ICE-Loop-Install-Stop.json');if(fs.existsSync(firstStop))fs.renameSync(firstStop,path.join(root,'fresh-stop.json'));
 if(failureSetup){
  const oldUninstallerHash=sha(uninstaller);
  await run('injected-extraction-failure',failureSetup,['/S','/currentuser','/D='+install],{timeout:600000,expected:22});
  await until(()=>!alive(original));app.ws.close();
  const recovery=path.join(root,'.ice-install-recovery');
  const rollbackRecords=fs.existsSync(recovery)?fs.readdirSync(recovery).map(name=>path.join(recovery,name,'manifest.json')).filter(file=>fs.existsSync(file)).map(file=>JSON.parse(fs.readFileSync(file))):[];
  check('failure_reached_real_extraction_then_rolled_back',rollbackRecords.some(tx=>tx.phase==='rolled_back'&&tx.failed_directories.some(dir=>fs.existsSync(path.join(dir,'resources/app.asar')))));
  check('failed_upgrade_restores_old_uninstaller',sha(uninstaller)===oldUninstallerHash&&registryPresent());
  for(const name of keepFiles)check('rollback_kept_'+name,fs.existsSync(path.join(install,name))&&sha(path.join(install,name))===hashes[name]);
  check('failed_upgrade_never_runs_legacy_uninstaller',!fs.existsSync(result.legacy_witness));
  app=await startApp(exe,runtime);original=app.child.pid;
  check('rollback_restart_retains_conversation',(await app.rpc('chat.list')).some(row=>row.id===conversation));
  check('failed_upgrade_keeps_other_instance',alive(foreignId));
 }
 await run('running-overwrite',setup,['/S','/currentuser','/D='+install],{timeout:600000});
 await until(()=>!alive(original));app.ws.close();
 if(legacyUpgrade){
  const reportFile=path.join(install,'ICE-UPGRADE-REPORT.json'),receipt=JSON.parse(fs.readFileSync(reportFile)),transaction=JSON.parse(fs.readFileSync(receipt.manifest));
  check('legacy_recursive_uninstaller_never_executed',!fs.existsSync(result.legacy_witness));
  check('legacy_upgrade_transaction_committed',transaction.phase==='committed');
  check('complete_old_installation_preserved',fs.existsSync(path.join(receipt.backup_roots[0],'Uninstall ICE Loop Studio.exe')));
  check('scattered_files_restored_without_overwrite',receipt.preserved_moves>=3&&receipt.conflicts.length===0);
  result.upgrade_receipt=receipt;result.installation_generation='current';save();
 }
 check('running_main_stopped_before_overwrite',!alive(original));
 check('unrelated_ice_installation_retained',alive(foreignId)&&(await foreign.rpc('bootstrap')).runtime_root===foreign.runtime);
 for(const name of keepFiles)check('upgrade_kept_'+name,fs.existsSync(path.join(install,name))&&sha(path.join(install,name))===hashes[name]);
 check('upgraded_asar_matches_candidate',sha(path.join(install,'resources/app.asar'))===sha(path.join(candidate,'release/win-unpacked/resources/app.asar')));
 const staged=path.join(root,'.ice-install-recovery');check('workspace_restored_to_original_directory',fs.existsSync(path.join(runtime,'app.db'))&&fs.existsSync(staged));
 app=await startApp(exe,runtime);check('real_restart_retains_conversation',(await app.rpc('chat.list')).some(row=>row.id===conversation));
 check('no_cloud_keys_after_upgrade',app.boot.settings.profiles.every(row=>!row.has_key));
 const license=path.join(install,'LICENSE.electron.txt');fs.appendFileSync(license,'\nUser local note\n');const licenseHash=sha(license);
 const secondMain=app.child.pid;await uninstall('running-uninstall');await until(()=>!alive(secondMain));app.ws.close();
 check('uninstall_stops_own_running_app',!alive(secondMain));check('uninstall_keeps_other_installation_alive',alive(foreignId));
 check('unchanged_program_exe_removed',!fs.existsSync(exe));check('unchanged_asar_removed',!fs.existsSync(path.join(install,'resources/app.asar')));
 check('modified_program_file_preserved',fs.existsSync(license)&&sha(license)===licenseHash);
 for(const name of keepFiles)check('uninstall_kept_'+name,fs.existsSync(path.join(install,name))&&sha(path.join(install,name))===hashes[name]);
 check('uninstall_keeps_database_and_settings',fs.existsSync(path.join(runtime,'app.db'))&&fs.existsSync(path.join(runtime,'settings.json')));
 check('test_registration_removed',!registryPresent());await closeSession(foreign);
 result.state='passed';
 }catch(error){result.state='failed';result.error=error.stack;process.exitCode=1;}finally{
 try{await stopOwn();if(result.installed&&!result.uninstalled&&fs.existsSync(uninstaller)){
  if(result.installation_generation==='legacy'){
   const code="$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);$b.DeleteSubKeyTree('Software\\"+guid+"',$false);$b.DeleteSubKeyTree('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+guid+"',$false);$b.Dispose()";
   const clean=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',code],{env,windowsHide:true,encoding:'utf8'});assert.equal(clean.status,0,clean.stderr);result.legacy_files_retained_after_failure=true; 
  }else await uninstall('cleanup-test-uninstall');
 }}catch(error){result.cleanup_error=error.stack;process.exitCode=1;}
 save();console.log(JSON.stringify({state:result.state,root,checks:Object.keys(result.checks).length}));process.exitCode=(result.state==='passed'||result.state==='reproduced-user-file-loss')&&!result.cleanup_error?0:1;}})();
