// Historical probe: completed-only logs cannot diagnose IPC hangs. Use fresh seed + interaction-integrity-native.cjs for acceptance.
'use strict';
// 真路径验证：paused 任务 UI 续跑 → 真实 running（引擎 mock 链路）→ 归档应先 stop。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(repo,'docs/上线准备/interaction-lists-fixture.json'),'utf8'));
const enter=async call=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',windowsVirtualKeyCode:13,code:'Enter',text:String.fromCharCode(13)});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',windowsVirtualKeyCode:13,code:'Enter'});};
(async()=>{
 const session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});
 const {evaluate,call,until}=session;
 const jobAction=async(label,expect)=>{const sel=`[...document.querySelectorAll('button')].find(b=>b.closest('li[data-job-id]')?.dataset.jobId==='job-kb-paused'&&b.innerText.trim()===${JSON.stringify(label)})`;
   await until(`Boolean(${sel})`);await evaluate(`${sel}.closest('li')?.scrollIntoView({block:'center'})`);await evaluate(`${sel}.focus()`);
   const before=fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes(expect)).length;
   await enter(call);
   const end=Date.now()+4000;while(Date.now()<end){const now=fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes(expect)).length;if(now>before)return;await new Promise(r=>setTimeout(r,200));}
   throw Error(label+' did not issue '+expect);};
 try{
  await until(`document.querySelectorAll('li[data-job-id]').length>=2`);
  // 对照 A：paused 卡的 RowAction 归档（与 done 卡同结构的 ghost sm 按钮）
  const archSel=`[...document.querySelectorAll('button')].find(b=>b.closest('li[data-job-id]')?.dataset.jobId==='job-kb-paused'&&b.innerText.trim()==='归档')`;
  await until(`Boolean(${archSel})`);await evaluate(`${archSel}.closest('li')?.scrollIntoView({block:'center'})`);await evaluate(`${archSel}.focus()`);
  console.log('paused archive focused:',await evaluate(`document.activeElement===(${archSel})`));
  await enter(call);await new Promise(r=>setTimeout(r,1500));
  console.log('paused archive via enter, jobs.archive count:',fs.readFileSync(fixture.observed,'utf8').split(String.fromCharCode(10)).filter(l=>l.includes('jobs.archive')).length);
  // 还原后再试续跑；先对比失效按钮(续跑/md)与有效按钮(ghost sm)的 computedStyle
  await evaluate(`window.ice.request('jobs.restore',{job_id:'job-kb-paused'}).then(()=>window.ice.request('jobs.list',{visibility:'all'})).catch(()=>0)`);
  const resumeSel=`[...document.querySelectorAll('button')].find(b=>b.closest('li[data-job-id]')?.dataset.jobId==='job-kb-paused'&&b.innerText.trim()==='续跑')`;
  await until(`Boolean(${resumeSel})`);
  console.log('resume btn style:',await evaluate(`(()=>{const r=${resumeSel};const s=getComputedStyle(r);return JSON.stringify({cls:r.className,transform:s.transform,pointerEvents:s.pointerEvents,filter:s.filter});})()`));
  console.log('rowaction btn style:',await evaluate(`(()=>{const r=${archSel};const s=getComputedStyle(r);return JSON.stringify({cls:r.className,transform:s.transform,pointerEvents:s.pointerEvents,filter:s.filter});})()`));
  await jobAction('续跑','jobs.resume');
  console.log('resume issued; badge:',await evaluate(`[...document.querySelectorAll('li[data-job-id="job-kb-paused"] .ice-badge')].map(b=>b.innerText.trim()).join(',')`));
  // 等引擎推进（mock 链路），观察状态迁移 8 秒
  for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,1000));
    console.log(i+'s badge:',await evaluate(`[...document.querySelectorAll('li[data-job-id="job-kb-paused"] .ice-badge')].map(b=>b.innerText.trim()).join(',')`));}
  const running=await evaluate(`window.ice.request('jobs.list',{visibility:'active'}).then(rows=>{const j=rows.find(r=>r.job_id==='job-kb-paused');return j&&{state:j.state,stopping:j.stopping};})`);
  console.log('final state:',JSON.stringify(running));
  if(running&&running.state==='running'&&!running.stopping){
    const sel=`[...document.querySelectorAll('button')].find(b=>b.closest('li[data-job-id]')?.dataset.jobId==='job-kb-paused'&&b.innerText.trim()==='归档')`;
    await until(`Boolean(${sel})`);await evaluate(`${sel}.closest('li')?.scrollIntoView({block:'center'})`);await evaluate(`${sel}.focus()`);
    console.log('archive focused:',await evaluate(`document.activeElement===(${sel})`));
    await enter(call);await new Promise(r=>setTimeout(r,1500));
    console.log('stop count:',fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes('jobs.stop')).length,
      'archive count:',fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes('jobs.archive')).length);
  }
 }finally{await session.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
