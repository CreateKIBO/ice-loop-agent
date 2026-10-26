"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'startup-recovery-fixture.json')));
assert.equal(path.dirname(f.root),path.join(repo,'.test-tmp/release-backup'));
assert(fs.existsSync(path.join(f.root,'.test-owner.json')));
const result={state:'running',runtime:f.runtime,root:f.root,checks:{},os_dialog_injected:true,selection_redirected:true};
const save=()=>{const text=JSON.stringify(result,null,2);fs.writeFileSync(path.join(out,'startup-recovery-native.json'),text);fs.writeFileSync(path.join(f.root,'startup-recovery-result.json'),text);};
const check=(name,value)=>{assert(value,name);result.checks[name]=true;save();};
const hash=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const selected=path.join(repo,'.desktop-data-path.json'),personalHash=hash(selected);
const selection=path.join(f.root,'selection.json'),planFile=path.join(f.root,'startup-plan.json');
const msg=(response,title)=>({kind:'message',response,title}),pick=file=>({kind:'open',canceled:false,filePaths:[file]});
async function launch(record,plan){
 fs.writeFileSync(selection,record);fs.writeFileSync(planFile,JSON.stringify(plan));
 const env={...process.env,TEMP:f.runtime,TMP:f.runtime,PYTHONUTF8:'1'};delete env.ICE_DESKTOP_RUNTIME;
 for(const k of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTHORIZATION/i.test(k))delete env[k];
 const log=fs.createWriteStream(path.join(f.root,'startup-launch-'+Date.now()+'.log'));
 const child=spawn(require('../node_modules/electron'),[f.entry,'--new-ui'],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 try{
  const code=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill();reject(Error('Startup recovery timeout'));},45000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
  assert.equal(code,0);assert.deepEqual(JSON.parse(fs.readFileSync(planFile)),[]);
 }finally{log.end();}
 check('no-unexpected-fatal-dialog',!fs.existsSync(path.join(f.root,'unexpected-error-box')));
}
const dbInfo=runtime=>JSON.parse(execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
 "import sqlite3,json,sys;from pathlib import Path;d=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);print(json.dumps({'schema':d.execute('PRAGMA user_version').fetchone()[0],'models':d.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],'tasks':dict(d.execute('SELECT task_id,state FROM tasks'))}));d.close()",path.join(runtime,'app.db')],{cwd:repo,encoding:'utf8',windowsHide:true,env:{...process.env,TEMP:f.runtime,TMP:f.runtime}}));
let session;
(async()=>{try{
 save();
 // Broken JSON must reach recovery before Python or an empty substitute database.
 await launch('{broken',[msg(0,'ICE Loop · 启动恢复'),pick(f.runtime),msg(1,'确认切换工作区'),msg(3,'ICE Loop · 启动恢复')]);
 check('malformed-selection-cancel-preserves-pointer',fs.readFileSync(selection,'utf8')==='{broken');
 check('recovery-profile-is-owned-and-no-engine-database',fs.existsSync(path.join(f.profile,'electron'))&&!fs.existsSync(path.join(f.profile,'app.db')));
 check('inspection-cleans-only-owned-scratch',!fs.existsSync(path.join(f.profile,'staging/startup-recovery'))||fs.readdirSync(path.join(f.profile,'staging/startup-recovery')).length===0);
 // Future schema: live engine rejects it; offline tool restores a reviewed ZIP.
 const future=path.join(f.root,'future'),futureHash=hash(path.join(future,'app.db')),packageHash=hash(f.package);
 await launch(JSON.stringify({runtime_root:future}),[msg(2,'ICE Loop · 启动恢复'),pick(f.package),msg(0,'确认备份内容'),pick(f.root),msg(1,'工作区已选定')]);
 const restored=JSON.parse(fs.readFileSync(selection)).runtime_root;
 check('restored-to-new-runtime',restored!==future&&restored.startsWith(f.root+path.sep)&&fs.existsSync(path.join(restored,'app.db')));
 check('future-source-database-byte-identical',hash(path.join(future,'app.db'))===futureHash);
 check('reviewed-zip-byte-identical',hash(f.package)===packageHash);
 check('restore-has-no-model-calls',dbInfo(restored).models===0);
 check('restore-tasks-remain-paused',Object.values(dbInfo(restored).tasks).every(state=>state==='paused'));
 check('restore-completes-schema-before-restart',dbInfo(restored).schema===f.target_schema);
 session=await openNativeSession(repo,f.runtime,{entryPath:f.entry,useWorkspaceSelection:true});
 await session.until(`Boolean(window.ice?.request)`);
 const boot=await session.evaluate(`window.ice.request('bootstrap')`);
 check('restored-workspace-opens-with-real-engine',boot.runtime_root===restored);
 const body=await session.evaluate(`window.ice.request('articles.document',{job_id:${JSON.stringify(f.job)}})`);
 check('restored-article-body-retained',body.markdown===f.body||JSON.stringify(body).includes('这是需要保留的原稿'));
 await session.close();session=null;
 // Checksum admission failure has the same rescue path, with explicit restart.
 const drift=path.join(f.root,'checksum'),driftHash=hash(path.join(drift,'app.db'));
 await launch(JSON.stringify({runtime_root:drift}),[msg(0,'ICE Loop · 启动恢复'),pick(f.runtime),msg(0,'确认切换工作区'),msg(0,'工作区已选定')]);
 check('checksum-source-database-byte-identical',hash(path.join(drift,'app.db'))===driftHash);
 check('confirmed-restart-requested',fs.existsSync(path.join(f.root,'relaunch-requested')));
 check('existing-workspace-selected-after-inspection',JSON.parse(fs.readFileSync(selection)).runtime_root===f.runtime);
 // New blank workspace is created only after confirmation, and engine stays off.
 await launch('{broken',[msg(1,'ICE Loop · 启动恢复'),pick(f.root),msg(0,'新建空白工作区'),msg(1,'工作区已选定')]);
 const fresh=JSON.parse(fs.readFileSync(selection));
 check('new-workspace-marked-fresh',fresh.fresh===true);
 check('new-workspace-empty-until-real-start',fs.readdirSync(fresh.runtime_root).length===0);
 session=await openNativeSession(repo,f.runtime,{entryPath:f.entry,useWorkspaceSelection:true});
 await session.until(`Boolean(window.ice?.request)`);
 const blank=await session.evaluate(`window.ice.request('bootstrap')`);
 check('fresh-workspace-opens-on-next-launch',blank.runtime_root===fresh.runtime_root);
 check('fresh-marker-consumed-after-successful-start',!JSON.parse(fs.readFileSync(selection)).fresh);
 check('new-workspace-no-model-calls',dbInfo(fresh.runtime_root).models===0);
 await session.close();session=null;
 check('personal-selection-never-touched',hash(selected)===personalHash);
 check('selection-temporary-files-cleaned',!fs.readdirSync(f.root).some(name=>name.startsWith('selection.json.')&&name.endsWith('.tmp')));
 result.state='finished';result.success=true;save();console.log(JSON.stringify(result,null,2));
 }catch(error){result.state='finished';result.error=error.stack;save();console.error(error);process.exitCode=1;}
 finally{if(session)await session.close();}
})();
