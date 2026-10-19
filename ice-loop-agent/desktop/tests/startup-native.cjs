'use strict';
// Repeated cold launches against one synthetic local workspace; no model calls.
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'editor-fixture.json'),'utf8'));
const report={state:'running',runtime:fixture.runtime,launches:[],success:false};
const save=()=>fs.writeFileSync(path.join(out,'startup-native.json'),JSON.stringify(report,null,2));
(async()=>{
 save();
 for(let index=0;index<3;index++){
  let session;
  const started=Date.now(),entry={index:index+1,success:false};report.launches.push(entry);save();
  try{
   session=await openNativeSession(repo,fixture.runtime);
   await session.until(`Boolean([...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='编辑正文'))`);
   const boot=await session.evaluate(`window.ice.request('bootstrap').then(r=>({version:r.version,account:r.account.id}))`);
   if(!boot.version||boot.account!=='ice-loop'||session.errors.length)throw Error('Unexpected startup state');
   entry.success=true;entry.duration_ms=Date.now()-started;
  }catch(error){entry.error=error.stack;}
  finally{if(session)await session.close();save();}
  if(!entry.success)break;
 }
 report.state='finished';report.success=report.launches.length===3&&report.launches.every(e=>e.success);save();
 console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;
})().catch(error=>{report.state='finished';report.error=error.stack;save();console.error(error);process.exitCode=1});
