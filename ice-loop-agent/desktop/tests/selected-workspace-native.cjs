'use strict';
// Startup only: use the real local workspace selection, never start production.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备/selected-workspace-native-2026-10-16.json');
const selection=JSON.parse(fs.readFileSync(path.join(repo,'.desktop-data-path.json'),'utf8'));
const runtime=path.resolve(selection.runtime_root),python=path.join(repo,'.venv/Scripts/python.exe');
if(!runtime.startsWith(repo+path.sep)||!path.basename(runtime).startsWith('.desktop-runtime-moved-'))throw Error('Unexpected migration workspace');
const report={state:'running',runtime,checks:{},errors:[]},save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
const snapshot=()=>JSON.parse(execFileSync(python,['-X','utf8','-B','-c',
 'import sqlite3,sys,json,hashlib;from pathlib import Path;from contextlib import closing;'+
 '\nwith closing(sqlite3.connect(Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True)) as c:'+
 '\n a=c.execute("SELECT article_id,spec_json FROM articles ORDER BY article_id").fetchall();'+
 '\n r=c.execute("SELECT job_id,state_json,content_hash FROM checkpoints ORDER BY job_id").fetchall();'+
 '\n print(json.dumps({"articles":len(a),"content_hash":hashlib.sha256(repr((a,r)).encode()).hexdigest(),"calls":c.execute("SELECT COUNT(*) FROM model_invocations").fetchone()[0]}))',
 path.join(runtime,'app.db')],{cwd:repo,env:{...process.env,TEMP:runtime,TMP:runtime},windowsHide:true,encoding:'utf8'}));
(async()=>{
 save();const before=snapshot();let session;
 try{
  session=await openNativeSession(repo,runtime,{useWorkspaceSelection:true});report.startupMs=session.startupMs;
  await session.until(`Boolean(document.querySelector('button'))`);
  const boot=await session.evaluate(`window.ice.request('bootstrap').then(r=>({runtime:r.runtime_root,jobs:r.jobs.length,articleRoot:r.account.article_root,library:r.account.library_root}))`);
  report.checks.actual_selector_used=path.resolve(boot.runtime)===runtime;
  report.checks.existing_two_jobs_visible=boot.jobs===2;
  report.checks.account_paths_on_new_workspace=[boot.articleRoot,boot.library].every(p=>path.resolve(p).startsWith(path.resolve(repo,'../..')+path.sep));
  report.checks.no_javascript_errors=session.errors.length===0;
  if(!Object.values(report.checks).every(Boolean))throw Error('Selected workspace startup verification failed');
 }catch(error){report.errors.push(error.stack||String(error));}
 finally{if(session)await session.close();}
 const after=snapshot();report.checks.articles_and_checkpoints_unchanged=before.content_hash===after.content_hash;
 report.checks.no_new_model_calls=before.calls===after.calls;
 report.state='finished';report.success=!report.errors.length&&Object.values(report.checks).every(Boolean);save();
 console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;
})().catch(error=>{report.state='finished';report.success=false;report.errors.push(error.stack||String(error));save();console.error(error);process.exitCode=1;});
