// Fresh candidate only: no old release overwrite, source cleanup, publish or installation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),desktop=path.join(repo,'desktop'),version=require('../desktop/package.json').version;
const root=path.join(repo,'.test-tmp/candidates',new Date().toISOString().slice(0,10)+'-'+crypto.randomUUID());
fs.mkdirSync(root,{recursive:true});for(const name of ['temp','cache','dist','logs'])fs.mkdirSync(path.join(root,name));
const marker=path.join(root,'CANDIDATE.json'),state={state:'building',root,project:repo,version,created_at:new Date().toISOString(),steps:[],installed:false,published:false};
const save=()=>fs.writeFileSync(marker,JSON.stringify(state,null,2));save();
const env={...process.env,PATH:path.dirname(process.execPath)+';'+process.env.PATH,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYINSTALLER_CONFIG_DIR:path.join(root,'cache/pyinstaller'),ELECTRON_BUILDER_CACHE:path.join(root,'cache/builder'),CSC_IDENTITY_AUTO_DISCOVERY:'false'};
for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','GH_TOKEN','GITHUB_TOKEN'])delete env[key];
function sources(){const map={};function scan(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(entry.isSymbolicLink())throw Error('Linked build input: '+entry.name);const full=path.join(folder,entry.name);if(entry.isDirectory()){if(!['__pycache__','node_modules','dist'].includes(entry.name))scan(full);}else if(/\.(py|json|cjs|ts|tsx|css|nsh|ps1|spec)$/.test(entry.name))map[path.relative(repo,full).replaceAll('\\','/')]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}}
 for(const name of ['ice_agent','profiles','build','desktop/ui/src','desktop/renderer','desktop/installer'])scan(path.join(repo,name));
 for(const name of ['tests/check_candidate_payload.py','desktop/tests/audit-candidate.cjs','desktop/tests/packaged-candidate-native.cjs','desktop/tests/native-session.cjs','tools/verify-frozen-recovery.py','tests/seed_startup_recovery_native.py','tests/seed_backup_native.py','tests/test_workflow.py','tests/schema_fixtures.py','tests/__init__.py']){map[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,name))).digest('hex');}
 for(const name of fs.readdirSync(desktop)){if(name.endsWith('.cjs')||['package.json','package-lock.json','electron-builder.json'].includes(name)){const p=path.join(desktop,name);if(fs.statSync(p).isFile())map['desktop/'+name]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}
 return Object.fromEntries(Object.entries(map).sort(([a],[b])=>a.localeCompare(b)));}
async function run(name,file,args,cwd=repo){const started=Date.now(),log=path.join(root,'logs',name+'.log'),fd=fs.openSync(log,'w');let code;
 try{code=await new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd,env,windowsHide:true,stdio:['ignore',fd,fd]});state.current_pid=child.pid;save();child.once('error',reject);child.once('exit',resolve);});}finally{fs.closeSync(fd);delete state.current_pid;}
 state.steps.push({name,exit_code:code,elapsed_ms:Date.now()-started,log});save();if(code!==0)throw Error(name+' failed; see '+log);console.log(JSON.stringify({step:name,exit:code,ms:Date.now()-started}));}
(async()=>{try{
 const before=sources();fs.writeFileSync(path.join(root,'source-before.json'),JSON.stringify(before,null,2));
 await run('classic-components',process.execPath,['desktop/build-components.cjs']);
 await run('new-ui',process.execPath,['build/build-new-ui.cjs']);
 await run('engine-freeze',path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-m','PyInstaller','--noconfirm','--clean','--distpath',path.join(root,'dist'),'--workpath',path.join(root,'pyinstaller'),path.join(repo,'build/ice-engine.spec')]);
 await run('resources',process.execPath,['build/prepare-release.cjs','--dist-root',path.join(root,'dist')]);
 const config=JSON.parse(fs.readFileSync(path.join(desktop,'electron-builder.json'),'utf8'));
 config.directories={...config.directories,output:path.join(root,'release')};config.electronDist=path.join(desktop,'node_modules/electron/dist');
 config.extraResources=config.extraResources.map(row=>({...row,from:path.join(root,'dist',path.basename(row.from))}));
 config.afterPack=path.join(repo,'build/install-file-manifest.cjs');config.afterSign=config.afterPack;
 const include=path.join(root,'installer.nsh');fs.writeFileSync(include,'!define ICE_INSTALL_FILE_MANIFEST "'+path.join(root,'release/install-files.json')+'"\n!include "'+path.join(desktop,'installer/installer.nsh')+'"\n');config.nsis.include=include;
 // Existing compiler binaries may be read from the machine cache, never modified there.
 const nsis=path.join(process.env.LOCALAPPDATA||'','electron-builder/Cache/nsis');
 if(fs.existsSync(nsis)){fs.mkdirSync(env.ELECTRON_BUILDER_CACHE,{recursive:true});fs.cpSync(nsis,path.join(env.ELECTRON_BUILDER_CACHE,'nsis'),{recursive:true});}
 const configFile=path.join(root,'builder.json');fs.writeFileSync(configFile,JSON.stringify(config,null,2));
 const targets=process.argv.includes('--installer')?['nsis','zip']:['zip'];
 await run('desktop-package',process.execPath,['build/package-desktop.cjs',configFile,...(targets.includes('nsis')?['--installer']:[])]);
 const after=sources();fs.writeFileSync(path.join(root,'source-after.json'),JSON.stringify(after,null,2));
 const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>before[key]!==after[key]);
 state.source_changes=changed;if(changed.length)throw Error('Source changed while building: '+changed.join(', '));
 state.state='built';state.verification='pending';state.targets=targets;state.executable=path.join(root,'release/win-unpacked/ICE Loop Studio.exe');save();
 await run('asar-audit',process.execPath,['desktop/tests/audit-candidate.cjs',root]);
 await run('payload-audit',path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','tests/check_candidate_payload.py',root]);
 if(process.argv.includes('--verify-desktop')){
   await run('frozen-desktop',process.execPath,['desktop/tests/packaged-candidate-native.cjs',root]);
   // A healthy workbench does not exercise the independent failure-recovery
   // entry. Test the frozen protocol too (including Windows Chinese encoding).
   const python=path.join(repo,'.venv/Scripts/python.exe');
   await run('seed-frozen-recovery',python,['-X','utf8','-B','tests/seed_startup_recovery_native.py']);
   const pinned=path.join(root,'startup-recovery-fixture.json');
   fs.copyFileSync(path.join(repo,'docs/上线准备/startup-recovery-fixture.json'),pinned);
   await run('frozen-recovery',python,['-X','utf8','-B','tools/verify-frozen-recovery.py','--candidate',root,'--fixture',pinned]);
 }
 const verified=sources();fs.writeFileSync(path.join(root,'source-after.json'),JSON.stringify(verified,null,2));
 state.source_changes=[...new Set([...Object.keys(before),...Object.keys(verified)])].filter(key=>before[key]!==verified[key]);
 if(state.source_changes.length)throw Error('Source changed during candidate verification: '+state.source_changes.join(', '));
 state.verification=process.argv.includes('--verify-desktop')?'payload-desktop-and-recovery-verified':'payload-verified';save();
 console.log(JSON.stringify({candidate:root,state:state.state,version,executable:state.executable}));
 }catch(error){state.state='failed';state.error=error.stack;save();console.error(error.stack);process.exitCode=1;}})();
