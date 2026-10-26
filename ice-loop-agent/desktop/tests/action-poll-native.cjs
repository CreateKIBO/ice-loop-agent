'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'glm-review-fixture.json'),'utf8'));
if(path.dirname(f.root)!==path.join(repo,'.test-tmp/release-glm-review')||!fs.existsSync(path.join(f.root,'.test-owner.json')))throw Error('Owned fixture required');
const before=process.argv.includes('--baseline'),report={state:'running',checks:{},scope:'source Electron; real isolated SQLite run/event rows; no tool/model execution',runtime:f.runtime};
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});
  const {evaluate,until}=session;
  await until(`Boolean(document.querySelector('button[title="GLM交互验收长会话"]'))`);
  await evaluate(`document.querySelector('button[title="GLM交互验收长会话"]').click()`);
  await until(`Boolean(document.querySelector('[aria-label="Agent 行动记录"] .ice-badge--info'))`);
  // Activate a synthetic stream after engine startup recovery. No model worker is created.
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE creative_messages SET status='streaming' WHERE id='review-1999'\");c.commit();c.close()",path.join(f.runtime,'app.db')],{cwd:repo,env:session.env,windowsHide:true});
  const records=()=>fs.existsSync(f.observed)?fs.readFileSync(f.observed,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  for(let n=0;n<200&&!records().some(r=>r.method==='events.poll'&&r.latest>0);n++)await wait(100);
  report.checks.real_nonzero_event_was_delivered=records().some(r=>r.method==='events.poll'&&r.latest>0);
  if(!report.checks.real_nonzero_event_was_delivered)throw Error('No nonzero tool event observed');
  await wait(300);
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE agent_runs SET status='completed' WHERE run_id='review-poll-run'\");c.execute(\"UPDATE creative_messages SET status='completed' WHERE id='review-1999'\");c.commit();c.close()",path.join(f.runtime,'app.db')],{cwd:repo,env:session.env,windowsHide:true});
  const limit=Date.now()+6500;let cleared=false;
  while(Date.now()<limit){cleared=await evaluate(`Boolean(document.querySelector('[aria-label="Agent 行动记录"]'))&&!document.querySelector('[aria-label="Agent 行动记录"] .ice-badge--info')`);if(cleared)break;await wait(150);}
  report.checks.background_completion_refreshes_without_new_event=cleared;
  report.checks.no_renderer_exceptions=session.errors.length===0;
  report.checks.no_synthetic_completed_event=records().filter(r=>r.method==='events.poll').every(r=>r.latest<=1);
  report.state=Object.values(report.checks).every(Boolean)?'finished':'failed';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{if(session)await session.close();fs.writeFileSync(path.join(out,before?'action-poll-before.json':'action-poll-native.json'),JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
