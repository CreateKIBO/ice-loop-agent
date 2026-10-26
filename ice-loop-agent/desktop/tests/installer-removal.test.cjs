const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {createInstallManifest}=require('../../build/install-file-manifest.cjs');
const repo=path.resolve(__dirname,'../..'),base=path.join(repo,'.test-tmp/owned-removal'),ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),script=path.join(repo,'desktop/installer/remove-owned-files.ps1');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function fixture(){const root=path.join(base,crypto.randomUUID()),install=path.join(root,'program with spaces');fs.mkdirSync(install,{recursive:true});return {root,install};}
function put(f,name,body){const p=path.join(f.install,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);return {path:name,bytes:Buffer.byteLength(body),sha256:hash(body)};}
function remove(f,rows,install=f.install){const manifest=path.join(f.root,'manifest.json'),report=path.join(f.root,'result-'+crypto.randomUUID()+'.json');fs.writeFileSync(manifest,JSON.stringify({schema:1,files:rows}));const p=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-InstallRoot',install,'-ManifestPath',manifest,'-ReportPath',report],{windowsHide:true,env:{...process.env,TEMP:f.root,TMP:f.root},encoding:'utf8',timeout:30000});return {code:p.status,error:p.stderr,report:fs.existsSync(report)?JSON.parse(fs.readFileSync(report)):null};}
test('uninstall removes only unchanged shipped bytes and retains user workspaces, assets and modified binaries',()=>{
 const f=fixture(),owned=put(f,'bin/program.dll','shipped'),changed=put(f,'bin/edited.dll','original');
 for(const name of ['my-article.md','ICE-Workspace-user/app.db','ICE-Workspace-user/settings.json','resources/user-image.svg'])put(f,name,'user content');
 fs.writeFileSync(path.join(f.install,changed.path),'changed by user');
 const r=remove(f,[owned,changed]);assert.equal(r.code,0,r.error);assert.deepEqual(r.report.removed,[owned.path]);assert.deepEqual(r.report.preserved_modified,[changed.path]);
 for(const name of ['my-article.md','ICE-Workspace-user/app.db','ICE-Workspace-user/settings.json','resources/user-image.svg'])assert.equal(fs.readFileSync(path.join(f.install,name),'utf8'),'user content');
 assert.equal(fs.readFileSync(path.join(f.install,changed.path),'utf8'),'changed by user');
 const again=remove(f,[owned,changed]);assert.equal(again.code,0,again.error);assert.deepEqual(again.report.missing,[owned.path]);
});
test('unsafe or duplicate manifest entries abort before the first valid file can be deleted',()=>{
 for(const kind of ['../outside.txt','/absolute.txt','name.txt:stream','bad./file.txt','NUL.txt','duplicate']){
  const f=fixture(),row=put(f,'bin/safe.txt','keep');let bad={...row,path:kind};
  if(kind==='duplicate')bad={...row,path:'BIN/SAFE.TXT'};
  const r=remove(f,[row,bad]);assert.equal(r.code,23,kind);assert.equal(fs.readFileSync(path.join(f.install,row.path),'utf8'),'keep');assert.deepEqual(r.report.removed,[]);
 }
});
test('junction in an install entry refuses the entire operation and preserves its external target',()=>{
 const f=fixture(),row=put(f,'safe.txt','keep'),outside=path.join(f.root,'external'),link=path.join(f.install,'linked');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'image.txt'),'outside');
 fs.symlinkSync(outside,link,'junction');
 try{const r=remove(f,[row,{path:'linked/image.txt',bytes:7,sha256:hash('outside')}]);assert.equal(r.code,23,r.error);assert.equal(fs.readFileSync(path.join(outside,'image.txt'),'utf8'),'outside');assert(fs.existsSync(path.join(f.install,'safe.txt')));}
 finally{fs.rmdirSync(link);}
});
test('drive roots and relative roots are rejected without deleting the payload',()=>{
 const f=fixture(),row=put(f,'safe.txt','keep');for(const install of [path.parse(f.install).root,'relative-path']){const r=remove(f,[row],install);assert.equal(r.code,23);assert(fs.existsSync(path.join(f.install,row.path)));}
});
test('manifest generator enumerates actual bytes and rejects linked payloads',async()=>{
 const f=fixture(),row=put(f,'bin/program.dll','real data');const m=await createInstallManifest(f.install);assert.deepEqual(m,{schema:1,files:[row]});
 const other=path.join(f.root,'other');fs.mkdirSync(other);const link=path.join(f.install,'linked');fs.symlinkSync(other,link,'junction');
 try{await assert.rejects(createInstallManifest(f.install),/Linked install payload/);}finally{fs.rmdirSync(link);}
});

test('ZIP-only manifest hook completes without waiting for an uninitialized NSIS target',{timeout:3000},async()=>{
 const f=fixture(),row=put(f,'program.dll','zip payload'),outDir=path.join(f.root,'output');
 await require('../../build/install-file-manifest.cjs')({appOutDir:f.install,outDir,targets:[{name:'zip'}]});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir,'install-files.json'))),{schema:1,files:[row]});
});

test('generated install receipts are removed only when identical to the embedded manifest',()=>{
 for(const changed of [false,true]){
  const f=fixture(),row=put(f,'program.dll','program'),body=changed?'user edited receipt':JSON.stringify({schema:1,files:[row]});
  const receipt=path.join(f.install,'ICE-INSTALL-FILES.json');fs.writeFileSync(receipt,body);
  const r=remove(f,[row]);assert.equal(r.code,0,r.error);assert.equal(fs.existsSync(receipt),changed);
  if(changed)assert.equal(fs.readFileSync(receipt,'utf8'),body);else assert(r.report.removed.includes('ICE-INSTALL-FILES.json'));
 }
});
