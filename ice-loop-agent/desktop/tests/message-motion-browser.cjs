'use strict';
// Actual MessageBubble/Motion components in Chrome; no service/model or OS IO.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),esbuild=require('esbuild');
const repo=path.resolve(__dirname,'../..'),ui=path.join(repo,'desktop/ui');
const parent=path.join(repo,'.test-tmp/message-motion');fs.mkdirSync(parent,{recursive:true});
const evidence=fs.mkdtempSync(path.join(parent,'run-'));
const paths=['features/chat/MessageBubble.tsx','components/ActivityRail.tsx','components/MarkdownContent.tsx','components/MarkdownView.tsx','components/CopyButton.tsx','components/ui.tsx','styles/conversation.css'];
const fingerprint=()=>Object.fromEntries(paths.map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ui,'src',file))).digest('hex')]));
const report={scope:'Chrome actual MessageBubble; React StrictMode; manual/system/parent preference; no service or model',sources:fingerprint(),checks:{},samples:[],errors:[]};
let browser,server;
async function run(){
  esbuild.buildSync({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {MotionConfig} from 'motion/react';import {MessageBubble} from './features/chat/MessageBubble';
    let sequence=0;
    function App(){
      const [policy,setPolicy]=React.useState('user'),[entry,setEntry]=React.useState({seq:0,role:'assistant',animate:false});
      window.setMessagePolicy=value=>flushSync(()=>setPolicy(value));
      window.mountMessage=(role,animate=true)=>flushSync(()=>setEntry({seq:++sequence,role,animate}));
      window.startEmptyMessage=()=>flushSync(()=>setEntry({seq:++sequence,role:'assistant',animate:true,content:'',status:'streaming'}));
      window.revealMessage=()=>flushSync(()=>setEntry(e=>({...e,content:'流式首次正文'})));
      window.appendMessage=()=>flushSync(()=>setEntry(e=>({...e,content:e.content+'，后续正文'})));
      return <MotionConfig reducedMotion={policy}><main id="message-host" style={{padding:24}}><MessageBubble key={entry.seq}
        row={{id:String(entry.seq),role:entry.role,content:entry.content??'键盘保留消息',status:entry.status??'completed',metadata:{},created_at:'2026-10-31T00:00:00Z'}}
        animateIn={entry.animate} onReuse={()=>{}}/></main></MotionConfig>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
  `,resolveDir:path.join(ui,'src'),loader:'tsx'},bundle:true,outfile:path.join(evidence,'app.js'),jsx:'automatic',logLevel:'silent'});
  server=http.createServer((req,res)=>{
    if(['/app.js','/app.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(evidence,req.url.slice(1))));}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await chromium.launch({executablePath:process.env.ICE_TEST_CHROME||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  const page=await browser.newPage({viewport:{width:600,height:700},reducedMotion:'no-preference'});
  page.on('pageerror',error=>report.errors.push(error.message));await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>window.mountMessage&&document.querySelector('.ice-markdown'));
  const check=(name,value)=>{report.checks[name]=!!value;fs.writeFileSync(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const sample=()=>page.locator('.ice-message').evaluate(n=>{const s=getComputedStyle(n),m=new DOMMatrix(s.transform);return {x:m.m41,y:m.m42,opacity:Number(s.opacity),same:n===window.messageNode,focused:n.contains(document.activeElement)};});
  const still=s=>Math.abs(s.x)<.01&&Math.abs(s.y)<.01;
  const policy=async value=>{await page.emulateMedia({reducedMotion:value==='system'?'reduce':'no-preference'});await page.evaluate(value=>{document.documentElement.dataset.reduceMotion=value==='manual'?'true':'false';window.setMessagePolicy(value==='parent'?'always':'user');},value);await frames();};
  const mount=async(role,animate=true)=>{await page.evaluate(({role,animate})=>window.mountMessage(role,animate),{role,animate});const initial=await sample();await frames();return {initial,frame:await sample()};};
  for(const role of ['user','assistant']){
    await policy('normal');let row=await mount(role,false);check(role+'_existing_history_has_no_entry_displacement',still(row.initial)&&still(row.frame));
    row=await mount(role);report.samples.push({role,policy:'normal',...row});check(role+'_normal_new_message_retains_entry',!still(row.initial));
    await page.waitForTimeout(700);check(role+'_normal_entry_finishes',still(await sample()));
    for(const value of ['manual','system','parent']){
      await policy(value);row=await mount(role);report.samples.push({role,policy:value,...row});check(role+'_'+value+'_new_message_has_no_displacement',still(row.frame));
    }
    await policy('normal');row=await mount(role);report.samples.push({role,policy:'restored-new',...row});check(role+'_restored_policy_animates_only_new_message',!still(row.initial));
    await page.waitForTimeout(700);
  }
  for(const value of ['manual','system','parent']){
    await policy('normal');const row=await mount('assistant');
    check(value+'_interruption_starts_during_real_motion',!still(row.frame));
    await page.evaluate(()=>{window.messageNode=document.querySelector('.ice-message');window.messageNode.querySelector('button').focus({preventScroll:true});});
    await policy(value);const interrupted=await sample();report.samples.push({policy:'interrupted-'+value,before:row.frame,after:interrupted});
    check(value+'_interruption_finishes_displacement',still(interrupted));
    check(value+'_interruption_keeps_node_and_focus',interrupted.same&&interrupted.focused);
    await policy('normal');const restored=await sample();
    check(value+'_restoration_does_not_replay_or_remount',still(restored)&&restored.same&&restored.focused);
    await page.waitForTimeout(700);
  }
  for(const value of ['normal','manual']){
    await policy(value);await page.evaluate(()=>window.startEmptyMessage());
    check(value+'_empty_streaming_message_has_no_bubble',await page.locator('.ice-message').count()===0);
    await page.evaluate(()=>window.revealMessage());const initial=await sample();await frames();const frame=await sample();
    report.samples.push({policy:'first-stream-content-'+value,initial,frame});
    check(value+'_first_stream_content_uses_current_motion_policy',value==='normal'?!still(initial):still(frame));
    await page.waitForTimeout(700);const settled=await sample();
    check(value+'_first_stream_content_finishes_visible',still(settled)&&settled.opacity>.99);
    await page.evaluate(()=>{window.messageNode=document.querySelector('.ice-message');window.appendMessage();});await frames();
    const append=await sample();check(value+'_stream_append_keeps_node_without_replay',append.same&&still(append)&&await page.locator('.ice-message').innerText().then(text=>text.includes('后续正文')));
  }
  check('no_renderer_errors',report.errors.length===0);check('source_unchanged_during_run',JSON.stringify(fingerprint())===JSON.stringify(report.sources));
  assert(Object.values(report.checks).every(Boolean),'Failed: '+Object.keys(report.checks).filter(key=>!report.checks[key]).join(', '));
}
run().catch(error=>{report.error=error.stack;process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({evidence,passed:Object.values(report.checks).filter(Boolean).length,total:Object.keys(report.checks).length,error:report.error}));
});
