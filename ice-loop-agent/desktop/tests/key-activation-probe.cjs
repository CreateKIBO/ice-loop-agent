// Historical probe: completed-only logs cannot diagnose IPC hangs. Use fresh seed + interaction-integrity-native.cjs for acceptance.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(repo,'docs/上线准备/interaction-lists-fixture.json'),'utf8'));
const enter=async call=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',windowsVirtualKeyCode:13,code:'Enter',text:String.fromCharCode(13)});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',windowsVirtualKeyCode:13,code:'Enter'});};
(async()=>{
 const session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});
 const {evaluate,call,until}=session;
 try{
  await until(`document.querySelectorAll('li[data-job-id]').length>=2`);
  // 对照 1：会话行按钮 + Enter
  const navSel=`[...document.querySelectorAll('.ice-nav-row button')].find(b=>b.getAttribute('aria-label')?.includes('键盘验收会话2'))`;
  await until(`Boolean(${navSel})`);
  await evaluate(`window.__nav=0;(${navSel}).addEventListener('click',()=>window.__nav++)`);
  await evaluate(`(${navSel}).focus()`);await enter(call);await new Promise(r=>setTimeout(r,1000));
  console.log('nav enter:',await evaluate('window.__nav'),'clicks; update count:',fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes('chat.update')).length);
  // 对照 2：任务卡按钮 + Enter（同会话同机制；先把任务置回 running 快照）
  const {execFileSync}=require('node:child_process');
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE jobs SET state='running' WHERE job_id=?\",(sys.argv[2],));c.commit();c.close()",
    path.join(fixture.runtime,'app.db'),'job-kb-running'],{cwd:repo,env:session.env,windowsHide:true});
  await until(`[...document.querySelectorAll('li[data-job-id="job-kb-running"] .ice-badge')].some(b=>b.innerText.trim()==='进行中')`);
  const jobSel=`[...document.querySelectorAll('button')].find(b=>b.closest('li[data-job-id]')?.dataset.jobId==='job-kb-running'&&b.innerText.trim()==='归档')`;
  await evaluate(`window.__job=0;(${jobSel}).addEventListener('click',()=>window.__job++)`);
  await evaluate(`(${jobSel}).focus()`);
  console.log('job focused:',await evaluate(`document.activeElement===(${jobSel})`));
  await enter(call);await new Promise(r=>setTimeout(r,1000));
  console.log('job enter:',await evaluate('window.__job'),'clicks; stop/archive:',fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes('jobs.stop')||l.includes('jobs.archive')).length);
  // Space 激活对照
  await evaluate(`(${jobSel}).focus()`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',windowsVirtualKeyCode:32,code:'Space',text:' '});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',windowsVirtualKeyCode:32,code:'Space'});
  await new Promise(r=>setTimeout(r,1000));
  console.log('after space total clicks:',await evaluate('window.__job'));
  // 真实鼠标点击对照（CDP Input.dispatchMouseEvent）
  const rect=JSON.parse(await evaluate(`(()=>{const b=${jobSel};const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`));
  await evaluate(`(${jobSel}).closest('li')?.scrollIntoView({block:'center'})`);
  await new Promise(r=>setTimeout(r,400));
  const rect2=JSON.parse(await evaluate(`(()=>{const b=${jobSel};const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,inView:r.top>=0&&r.bottom<=innerHeight});})()`));
  console.log('after scroll rect:',rect2,'hit:',await evaluate(`(()=>{const el=document.elementFromPoint(${rect2.x},${rect2.y});return el?String(el.tagName)+'|'+String(el.closest('button')?.innerText||el.className).slice(0,30):'none';})()`));
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect2.x,y:rect2.y,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect2.x,y:rect2.y,button:'left',clickCount:1});
  await new Promise(r=>setTimeout(r,1500));
  console.log('clicks after scrolled real mouse:',await evaluate('window.__job'),'; stop/archive:',fs.readFileSync(fixture.observed,'utf8').split(String.fromCharCode(10)).filter(l=>l.includes('jobs.stop')||l.includes('jobs.archive')).length);
  if(true)return;
  console.log('overlays:',await evaluate(`[...document.querySelectorAll('body *')].filter(e=>{const s=getComputedStyle(e);return s.position==='fixed'&&s.pointerEvents!=='none'&&e.getBoundingClientRect().height>100}).map(e=>e.className||e.tagName).slice(0,5).join(',')`));
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});
  await new Promise(r=>setTimeout(r,1200));
  console.log('after real mouse total clicks:',await evaluate('window.__job'),'; stop/archive:',fs.readFileSync(fixture.observed,'utf8').split('\n').filter(l=>l.includes('jobs.stop')||l.includes('jobs.archive')).length);
 }finally{await session.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
