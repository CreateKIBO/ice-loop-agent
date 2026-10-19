'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'resource-fixture.json'),'utf8'));
const result={fixture,samples:[],errors:[]};
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime);
  const {evaluate,call,until}=session;
  await until(`Boolean(document.querySelector('button[title="压力会话00"]'))`);
  // Startup correctly marks abandoned streaming records interrupted. Activate
  // only this synthetic workload after startup; no inference worker is started.
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-B','-c',
   "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE creative_messages SET status='streaming' WHERE id LIKE 'resource-message-%'\");c.commit();c.close()",
   path.join(fixture.runtime,'app.db')],{cwd:repo,env:session.env,windowsHide:true});
  const sample=async(stage)=>{await call('HeapProfiler.collectGarbage');const heap=await call('Runtime.getHeapUsage');const dom=await call('Memory.getDOMCounters');
   const processMemory=['cold','threads-20','settled'].includes(stage)?JSON.parse(execFileSync('powershell.exe',
    ['-NoProfile','-NonInteractive','-File',path.join(__dirname,'sample-owned-memory.ps1'),'-RootProcessId',String(session.pid)],
    {cwd:repo,encoding:'utf8',windowsHide:true})):undefined;
   const value={stage,used_js_heap:heap.usedSize,total_js_heap:heap.totalSize,documents:dom.documents,nodes:dom.nodes,listeners:dom.jsEventListeners,processMemory};result.samples.push(value);console.log(JSON.stringify(value));};
  await sample('cold');
  for(let i=0;i<fixture.threads;i++){
   const title='压力会话'+String(i).padStart(2,'0');
   await evaluate(`document.querySelector('button[title='+CSS.escape(${JSON.stringify(title)})+']').click()`);
   await until(`document.querySelector('.ice-conversation-header h1')?.innerText===${JSON.stringify(title)}`);
   await until(`document.querySelector('.ice-turn-progress__label')?.innerText.includes('任务状态')`);
   await wait(60);
   if([9,19,29,39].includes(i))await sample('threads-'+(i+1));
  }
  // Allow observers from detached views to be reclaimed before the final sample.
  await wait(500);await sample('settled');
  result.errors=session.errors;
  const warm=result.samples.find(row=>row.stage==='threads-20'),last=result.samples.at(-1);
  result.post_warm_growth_bytes=last.used_js_heap-warm.used_js_heap;
  result.passed=result.errors.length===0 && result.post_warm_growth_bytes<5*1024*1024
    && last.nodes<10000 && last.nodes-warm.nodes<1000 && last.listeners-warm.listeners<500;
  if(!result.passed)throw Error('Resource workload exceeded scoped heap/DOM regression limits');
 }catch(error){result.errors.push(error.stack);result.passed=false;}
 finally{if(session)await session.close();fs.writeFileSync(path.join(out,'native-resource-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,errors:result.errors,post_warm_growth_bytes:result.post_warm_growth_bytes}));if(!result.passed)process.exitCode=1;}
})().catch(error=>{console.error(error);process.exitCode=1;});
