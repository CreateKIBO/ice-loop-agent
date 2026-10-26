const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync,spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),script=path.join(repo,'desktop/installer/upgrade-transaction.ps1');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex'),quote=value=>"'"+value.replaceAll("'","''")+"'";
function powershell(f,code){const p=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,env:{...process.env,TEMP:f.temp,TMP:f.temp},encoding:'utf8',timeout:30000});assert.equal(p.status,0,p.stderr);return p.stdout;}
function setRegistration(f,version='old'){
 powershell(f,"$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);$k=$b.CreateSubKey('Software\\"+f.guid+"');$k.SetValue('InstallLocation',"+quote(f.install)+");$k.SetValue('UserSetting','"+version+"');$k.SetValue('Multi',[string[]]@('one','two'),[Microsoft.Win32.RegistryValueKind]::MultiString);$k.SetValue('Binary',[byte[]]@(1,2,255),[Microsoft.Win32.RegistryValueKind]::Binary);$k.Dispose();$u=$b.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+f.guid+"');$u.SetValue('UninstallString',"+quote('"'+path.join(f.install,'Uninstall ICE Loop Studio.exe')+'" /'+version)+");$u.SetValue('DisplayVersion','"+version+"');$u.Dispose();$b.Dispose();");
}
function registry(f){return JSON.parse(powershell(f,"$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);$k=$b.OpenSubKey('Software\\"+f.guid+"');$u=$b.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+f.guid+"');@{setting=$k.GetValue('UserSetting');uninstall=$u.GetValue('UninstallString');multi=@($k.GetValue('Multi'));binary=[Convert]::ToBase64String($k.GetValue('Binary'))}|ConvertTo-Json -Compress;$k.Dispose();$u.Dispose();$b.Dispose();"));}
function fixture(){
 const root=path.join(repo,'.test-tmp/upgrade-transaction',crypto.randomUUID()),install=path.join(root,'program with spaces'),temp=path.join(root,'temp'),guid=crypto.randomUUID();fs.mkdirSync(install,{recursive:true});fs.mkdirSync(temp);
 const f={root,install,temp,guid,stage:path.join(temp,'stage.txt'),payload:path.join(root,'input.json')};
 const old={'ICE Loop Studio.exe':'old exe','Uninstall ICE Loop Studio.exe':'old uninstall','resources/app.asar':'old asar','resources/engine/ice-engine.exe':'old engine'};
 const next={'ICE Loop Studio.exe':'new exe','resources/app.asar':'new asar','resources/engine/ice-engine.exe':'new engine'};
 for(const [name,body] of Object.entries(old))put(f.install,name,body);
 fs.writeFileSync(f.payload,JSON.stringify({schema:1,files:Object.entries(next).map(([name,body])=>({path:name,bytes:Buffer.byteLength(body),sha256:sha(body)}))}));
 f.next=next;setRegistration(f);return f;
}
function put(root,name,body){const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);return target;}
function call(f,mode,override={}){
 const report=path.join(f.temp,'result-'+crypto.randomUUID()+'.json'),p=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Mode',mode,'-InstallRoot',override.install||f.install,'-AppGuid',f.guid,'-StageFile',f.stage,'-PayloadManifest',f.payload,'-StopScript',path.join(repo,'desktop/installer/stop-agent.ps1'),'-ReportPath',report],{cwd:override.cwd,env:{...process.env,TEMP:f.temp,TMP:f.temp},windowsHide:true,encoding:'utf8',timeout:45000});
 return {code:p.status,error:p.stderr,output:p.stdout,report:fs.existsSync(report)?JSON.parse(fs.readFileSync(report)):null};
}
function record(f){const name=fs.readFileSync(f.stage,'utf8');return {name,data:JSON.parse(fs.readFileSync(name))};}
function extract(f){for(const [name,body] of Object.entries(f.next))put(f.install,name,body);put(f.install,'Uninstall ICE Loop Studio.exe','new uninstall');setRegistration(f,'new');}
function cleanup(f){powershell(f,"$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);$b.DeleteSubKeyTree('Software\\"+f.guid+"',$false);$b.DeleteSubKeyTree('Software\\"+f.guid+".Upgrade',$false);$b.DeleteSubKeyTree('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+f.guid+"',$false);$b.Dispose();");}
test('whole-folder stage shields scattered files, then restores unknown data without running a legacy uninstaller',()=>{
 const f=fixture();try{
  const kept=['my-articles/body.md','resources/custom/brand.svg','ICE-Workspace-user/app.db','ICE-Workspace-user/settings.json'];
  for(const name of kept)put(f.install,name,'user:'+name);
  let r=call(f,'Stage');assert.equal(r.code,0,r.error);assert(!fs.existsSync(f.install));const tx=record(f);assert(fs.existsSync(path.join(tx.data.roots[0].backup,'my-articles/body.md')));assert.equal(registry(f).uninstall,null);
  extract(f);r=call(f,'Commit');assert.equal(r.code,0,r.error);assert.equal(record(f).data.phase,'committed');
  for(const name of kept)assert.equal(fs.readFileSync(path.join(f.install,name),'utf8'),'user:'+name);
  assert.equal(fs.readFileSync(path.join(f.install,'resources/app.asar'),'utf8'),'new asar');
  assert(fs.existsSync(path.join(f.install,'ICE-INSTALL-FILES.json')));
  const count=record(f).data.moves.length;assert.equal(call(f,'Commit').code,0);assert.equal(call(f,'Rollback').code,0);assert.equal(record(f).data.moves.length,count);assert.equal(registry(f).setting,'new');
 }finally{cleanup(f);}
});
test('stage and rollback are repeatable and restore registry value types and original bytes',()=>{
 const f=fixture();try{
  const before=registry(f);put(f.install,'note.md','keep');
  let r=call(f,'Stage');assert.equal(r.code,0,r.error);r=call(f,'Stage');assert.equal(r.code,0,r.error);
  r=call(f,'Rollback');assert.equal(r.code,0,r.error);assert.equal(fs.readFileSync(path.join(f.install,'note.md'),'utf8'),'keep');assert.deepEqual(registry(f),before);
  assert.equal(call(f,'Rollback').code,0);
 }finally{cleanup(f);}
});
test('failed extraction restores the old program and preserves the partial new program for recovery',()=>{
 const f=fixture();try{
  const before=registry(f);put(f.install,'note.md','keep');assert.equal(call(f,'Stage').code,0);extract(f);put(f.install,'resources/app.asar','broken extraction');
  const r=call(f,'Commit');assert.equal(r.code,22);assert.equal(record(f).data.phase,'rolled_back');assert.equal(fs.readFileSync(path.join(f.install,'resources/app.asar'),'utf8'),'old asar');assert.equal(fs.readFileSync(path.join(f.install,'note.md'),'utf8'),'keep');assert.deepEqual(registry(f),before);
  assert.equal(record(f).data.failed_directories.length,1);
 }finally{cleanup(f);}
});
test('conflicting unknown files are never overwritten and remain discoverable in recovery',()=>{
 const f=fixture();try{
  put(f.install,'resources/user.svg','old user image');assert.equal(call(f,'Stage').code,0);extract(f);put(f.install,'resources/user.svg','concurrent new image');
  const r=call(f,'Commit');assert.equal(r.code,0,r.error);const tx=record(f).data;assert.equal(tx.conflicts.length,1);assert.equal(fs.readFileSync(tx.conflicts[0].saved,'utf8'),'old user image');assert.equal(fs.readFileSync(path.join(f.install,'resources/user.svg'),'utf8'),'concurrent new image');
 }finally{cleanup(f);}
});
test('unknown junction moves as a link while its outside target remains untouched',()=>{
 const f=fixture(),outside=path.join(f.root,'external'),link=path.join(f.install,'my-link');fs.mkdirSync(outside);put(outside,'data.txt','outside');fs.symlinkSync(outside,link,'junction');
 try{assert.equal(call(f,'Stage').code,0);extract(f);const r=call(f,'Commit');assert.equal(r.code,0,r.error);assert(fs.lstatSync(link).isSymbolicLink());assert.equal(fs.readFileSync(path.join(outside,'data.txt'),'utf8'),'outside');}
 finally{if(fs.existsSync(link)&&fs.lstatSync(link).isSymbolicLink())fs.rmdirSync(link);cleanup(f);}
});
test('nested targets are rejected before directory or registration mutation',()=>{
 const f=fixture();try{const before=registry(f),r=call(f,'Stage',{install:path.join(f.install,'nested')});assert.equal(r.code,22);assert.match(r.report.error,/Nested installation/);assert(fs.existsSync(path.join(f.install,'ICE Loop Studio.exe')));assert.deepEqual(registry(f),before);}finally{cleanup(f);}
});
test('rollback reconciles an interrupted rename before the staged flag was persisted',()=>{
 const f=fixture();try{const before=registry(f);assert.equal(call(f,'Stage').code,0);const tx=record(f);tx.data.phase='staging';tx.data.roots[0].staged=false;fs.writeFileSync(tx.name,JSON.stringify(tx.data));const r=call(f,'Rollback');assert.equal(r.code,0,r.error);assert(fs.existsSync(path.join(f.install,'ICE Loop Studio.exe')));assert.deepEqual(registry(f),before);}finally{cleanup(f);}
});

test('fresh install commits without manufacturing an old installation or rollback target',()=>{
 const f=fixture();try{
  cleanup(f);const unused=path.join(f.root,'unused-old-fixture');fs.renameSync(f.install,unused);
  let r=call(f,'Stage');assert.equal(r.code,0,r.error);assert.equal(record(f).data.phase,'fresh');extract(f);
  r=call(f,'Commit');assert.equal(r.code,0,r.error);assert.equal(record(f).data.roots.length,0);assert.equal(record(f).data.phase,'committed');assert(fs.existsSync(path.join(f.install,'ICE-INSTALL-FILES.json')));
 }finally{cleanup(f);}
});
test('unknown workspace with paths longer than MAX_PATH survives atomic restoration',()=>{
 const f=fixture();try{
  const relative=path.join('ICE-Workspace-long','a'.repeat(90),'b'.repeat(90),'c'.repeat(90),'note.md');const target=put(f.install,relative,'long path user data');
  assert(target.length>260);let r=call(f,'Stage');assert.equal(r.code,0,r.error);extract(f);r=call(f,'Commit');assert.equal(r.code,0,r.error);assert.equal(fs.readFileSync(target,'utf8'),'long path user data');
 }finally{cleanup(f);}
});

test('an interrupted unknown-data restore is journalled and a later rollback restores every file',{timeout:45000},async()=>{
 const f=fixture();let child;try{
  const before=registry(f);for(let i=0;i<70;i++)put(f.install,'user-'+String(i).padStart(3,'0')+'.md','data-'+i);
  assert.equal(call(f,'Stage').code,0);extract(f);
  child=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Mode','Commit','-InstallRoot',f.install,'-AppGuid',f.guid,'-StageFile',f.stage],{env:{...process.env,TEMP:f.temp,TMP:f.temp},windowsHide:true,stdio:'ignore'});
  let observed=false;const until=Date.now()+20000;
  while(Date.now()<until&&child.exitCode===null){try{if(record(f).data.moves.some(row=>row.performed)){observed=true;break;}}catch{}await new Promise(r=>setTimeout(r,5));}
  assert(observed,'must observe a real committed move before interruption');
  const ended=new Promise(resolve=>child.once('exit',resolve));assert.equal(child.exitCode,null);child.kill();await ended;
  const r=call(f,'Rollback');assert.equal(r.code,0,r.error);
  for(let i=0;i<70;i++)assert.equal(fs.readFileSync(path.join(f.install,'user-'+String(i).padStart(3,'0')+'.md'),'utf8'),'data-'+i);
  assert.deepEqual(registry(f),before);
 }finally{if(child&&child.exitCode===null)child.kill();cleanup(f);}
});
test('a journal move outside its staged root is refused before any recovery mutation',()=>{
 const f=fixture();try{
  const outside=put(f.root,'outside.md','outside');assert.equal(call(f,'Stage').code,0);const tx=record(f),original=fs.readFileSync(tx.name);
  tx.data.moves=[{source:outside,target:path.join(f.install,'outside.md'),performed:true}];fs.writeFileSync(tx.name,JSON.stringify(tx.data));
  const r=call(f,'Rollback');assert.equal(r.code,22);assert.match(r.report.error,/escaped/);assert.equal(fs.readFileSync(outside,'utf8'),'outside');
  fs.writeFileSync(tx.name,original);assert.equal(call(f,'Rollback').code,0);
 }finally{cleanup(f);}
});

test('missing manifest after a legacy ReplaceFile interruption recovers the complete pending intent',()=>{
 const f=fixture();try{
  put(f.install,'user.md','important');assert.equal(call(f,'Stage').code,0);extract(f);
  const tx=record(f),source=path.join(tx.data.roots[0].backup,'user.md'),target=path.join(f.install,'user.md');
  tx.data.moves=[{source,target,performed:false}];
  fs.writeFileSync(tx.name+'.pending',JSON.stringify(tx.data));fs.renameSync(tx.name,tx.name+'.previous');fs.renameSync(source,target);
  const r=call(f,'Rollback');assert.equal(r.code,0,r.error);assert.equal(record(f).data.phase,'rolled_back');assert.equal(fs.readFileSync(target,'utf8'),'important');
 }finally{cleanup(f);}
});

test('rollback resumes after the entire old root was already restored',()=>{
 const f=fixture();try{
  const before=registry(f);put(f.install,'user.md','keep');assert.equal(call(f,'Stage').code,0);extract(f);
  const tx=record(f),source=path.join(tx.data.roots[0].backup,'user.md'),target=path.join(f.install,'user.md');
  tx.data.phase='rolling_back';tx.data.moves=[{source,target,performed:true}];fs.writeFileSync(tx.name,JSON.stringify(tx.data));
  fs.renameSync(f.install,path.join(f.root,'simulated-partial-new'));
  fs.renameSync(tx.data.roots[0].backup,f.install);
  const r=call(f,'Rollback');assert.equal(r.code,0,r.error);assert.equal(fs.readFileSync(path.join(f.install,'resources/app.asar'),'utf8'),'old asar');assert.equal(fs.readFileSync(target,'utf8'),'keep');assert.deepEqual(registry(f),before);
 }finally{cleanup(f);}
});
test('a new installer process recovers a staged installation using its durable pointer',()=>{
 const f=fixture();try{
  put(f.install,'user.md','keep');assert.equal(call(f,'Stage').code,0);const old=record(f);
  f.stage=path.join(f.temp,'new-installer-stage.txt');
  const r=call(f,'Stage');assert.equal(r.code,0,r.error);assert.equal(JSON.parse(fs.readFileSync(old.name)).phase,'rolled_back');
  const current=record(f);assert.notEqual(current.name,old.name);assert.equal(fs.readFileSync(path.join(current.data.roots[0].backup,'user.md'),'utf8'),'keep');
  extract(f);assert.equal(call(f,'Commit').code,0);assert.equal(fs.readFileSync(path.join(f.install,'user.md'),'utf8'),'keep');
 }finally{cleanup(f);}
});
test('an unregistered ICE directory upgrades without treating missing registry values as paths',()=>{
 const f=fixture();try{
  cleanup(f);put(f.install,'user.md','keep');assert.equal(call(f,'Stage').code,0);extract(f);
  const r=call(f,'Commit');assert.equal(r.code,0,r.error);assert.equal(fs.readFileSync(path.join(f.install,'user.md'),'utf8'),'keep');
 }finally{cleanup(f);}
});
test('canonical traversal in a recorded move is rejected before any mutation',()=>{
 const f=fixture();try{
  assert.equal(call(f,'Stage').code,0);const tx=record(f),original=fs.readFileSync(tx.name);
  tx.data.moves=[{source:tx.data.roots[0].backup+'/../outside.md',target:path.join(f.install,'outside.md'),performed:false}];fs.writeFileSync(tx.name,JSON.stringify(tx.data));
  const r=call(f,'Rollback');assert.equal(r.code,22);assert.match(r.report.error,/canonical/);
  fs.writeFileSync(tx.name,original);assert.equal(call(f,'Rollback').code,0);
 }finally{cleanup(f);}
});

test('a corrupt durable recovery identity cannot trigger automatic rollback on a new Stage',()=>{
 const f=fixture();try{
  put(f.install,'keep.md','keep');assert.equal(call(f,'Stage').code,0);const tx=record(f),original=fs.readFileSync(tx.name);
  tx.data.app_guid=crypto.randomUUID();fs.writeFileSync(tx.name,JSON.stringify(tx.data));f.stage=path.join(f.temp,'new-stage.txt');
  const r=call(f,'Stage');assert.equal(r.code,22);assert.match(r.report.error,/identity/);
  assert(!fs.existsSync(f.install));assert.equal(fs.readFileSync(path.join(tx.data.roots[0].backup,'keep.md'),'utf8'),'keep');
  fs.writeFileSync(tx.name,original);assert.equal(call(f,'Stage').code,0);assert.equal(call(f,'Rollback').code,0);
 }finally{cleanup(f);}
});

test('NSIS-sized invocations resolve extracted helper paths without repeating long arguments',()=>{
 const f=fixture();try{
  const local=path.join(f.temp,'ice-upgrade.ps1');fs.copyFileSync(script,local);
  fs.copyFileSync(path.join(repo,'desktop/installer/stop-agent.ps1'),path.join(f.temp,'ice-stop-agent.ps1'));
  fs.copyFileSync(f.payload,path.join(f.temp,'ice-install-files.json'));f.stage=path.join(f.temp,'ice-upgrade-stage.txt');
  put(f.install,'user.md','keep');
  function invoke(mode){
   const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',local,'-Mode',mode,'-InstallRoot',f.install,'-AppGuid',f.guid,'-InstallMode','CurrentUser','-RegistryView','64'];
   assert(args.join(' ').length+ps.length<1024,'NSIS command remains within its string limit');
   return spawnSync(ps,args,{env:{...process.env,TEMP:f.temp,TMP:f.temp},windowsHide:true,encoding:'utf8',timeout:45000});
  }
  let r=invoke('Stage');assert.equal(r.status,0,r.stderr);assert.equal(record(f).data.phase,'staged');extract(f);
  r=invoke('Commit');assert.equal(r.status,0,r.stderr);assert.equal(record(f).data.phase,'committed');assert.equal(fs.readFileSync(path.join(f.install,'user.md'),'utf8'),'keep');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.temp,'ICE-Loop-Upgrade.json'))).phase,'committed');
 }finally{cleanup(f);}
});


test('native NSIS System.dll cannot shadow the managed assembly in any upgrade phase',()=>{
 const f=fixture();try{
  // Full NSIS installers extract a native System.dll plugin into their working directory.
  put(f.temp,'System.dll','native plugin, not a managed reference assembly');
  put(f.install,'article.md','important');const before=registry(f);
  const invoke=mode=>call(f,mode,{cwd:f.temp});
  let r=invoke('Stage');assert.equal(r.code,0,r.error);extract(f);
  r=invoke('Rollback');assert.equal(r.code,0,r.error);assert.deepEqual(registry(f),before);
  f.stage=path.join(f.temp,'retry-installer-stage.txt');
  r=invoke('Stage');assert.equal(r.code,0,r.error);extract(f);
  r=invoke('Commit');assert.equal(r.code,0,r.error);
  assert.equal(fs.readFileSync(path.join(f.install,'article.md'),'utf8'),'important');
  assert.equal(record(f).data.phase,'committed');
 }finally{cleanup(f);}
});
