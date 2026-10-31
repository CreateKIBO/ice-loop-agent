'use strict';
// Existing Chrome component framework; synthetic events, no engine/model.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),esbuild=require('esbuild');
const repo=path.resolve(__dirname,'../..'),ui=path.join(repo,'desktop/ui'),parent=path.join(repo,'.test-tmp/progress-feedback');fs.mkdirSync(parent,{recursive:true});
const evidence=fs.mkdtempSync(path.join(parent,'run-'));
const paths=['features/chat/TurnProgress.tsx','features/chat/progressFeedback.ts','components/ActivityRail.tsx','data/eventStream.ts','components/errorText.ts','styles/feedback.css'];
const fingerprint=()=>Object.fromEntries(paths.map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ui,'src',file))).digest('hex')]));
const report={scope:'Chrome real StrictMode TurnProgress; synthetic events/manual/system/parent preference; no model or IPC',checks:{},samples:[],errors:[],sources:fingerprint()};
let browser,server;
async function run(){
  esbuild.buildSync({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {MotionConfig} from 'motion/react';import {TurnProgress} from './features/chat/TurnProgress';import './styles/tokens.css';import './styles/base.css';import './styles/components.css';import './styles/feedback.css';
    const timers=new Set(),listeners=new Set(),setTimer=window.setInterval.bind(window),clearTimer=window.clearInterval.bind(window);
    window.setInterval=(...args)=>{const id=setTimer(...args);if(args[1]===1000)timers.add(id);return id;};window.clearInterval=id=>{timers.delete(id);clearTimer(id);};
    const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
    document.addEventListener=(type,listener,...args)=>{if(type==='visibilitychange')listeners.add(listener);return add(type,listener,...args);};
    document.removeEventListener=(type,listener,...args)=>{if(type==='visibilitychange')listeners.delete(listener);return remove(type,listener,...args);};
    window.feedbackStats=()=>({timers:timers.size,listeners:listeners.size});window.feedbackVisible=true;
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.feedbackVisible?'visible':'hidden'});
    window.setFeedbackVisible=value=>{window.feedbackVisible=value;document.dispatchEvent(new Event('visibilitychange'));};
    let sequence=2;
    const initial=[{sequence:1,type:'turn.started',created_at:new Date().toISOString(),payload:{turn_id:'progress-test'}},{sequence:2,type:'turn.phase',payload:{turn_id:'progress-test',phase:'waiting_model'}}];
    function App(){
      const [events,setEvents]=React.useState(initial),[policy,setPolicy]=React.useState('user');
      window.setProgressPolicy=value=>flushSync(()=>setPolicy(value));
      window.progressPhase=phase=>flushSync(()=>setEvents(old=>[...old,{sequence:++sequence,type:'turn.phase',payload:{turn_id:'progress-test',phase}}]));
      window.progressFailure=()=>flushSync(()=>setEvents(old=>[...old,{sequence:++sequence,type:'turn.finished',created_at:new Date().toISOString(),payload:{turn_id:'progress-test',status:'failed',error_message:'受控失败 api_key=fixture-progress-value Authorization: Basic dXNlcjpwYXNz'}}]));
      return <MotionConfig reducedMotion={policy}><main style={{padding:16}}><TurnProgress turnId="progress-test" events={events} metadata={{progress:'receiving'}}/></main></MotionConfig>;
    }
    const root=createRoot(document.getElementById('root'));window.unmountFeedback=()=>root.unmount();root.render(<React.StrictMode><App/></React.StrictMode>);
  `,resolveDir:path.join(ui,'src'),loader:'tsx'},bundle:true,outfile:path.join(evidence,'app.js'),jsx:'automatic',logLevel:'silent'});
  server=http.createServer((req,res)=>{if(['/app.js','/app.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(evidence,req.url.slice(1))));}else{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await chromium.launch({executablePath:process.env.ICE_TEST_CHROME||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  const page=await browser.newPage({viewport:{width:320,height:600},reducedMotion:'no-preference'});page.on('pageerror',e=>report.errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.progressPhase);
  const check=(name,value)=>{report.checks[name]=!!value;fs.writeFileSync(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await frames();check('strict_mode_has_one_active_elapsed_timer',await page.evaluate(()=>window.feedbackStats().timers===1));
  await page.evaluate(()=>{
    window.phaseSamples=[];const seen=new WeakSet();
    new MutationObserver(()=>document.querySelectorAll('.ice-turn-progress__label,.ice-turn-step').forEach(n=>{
      if(seen.has(n))return;seen.add(n);const kind=n.matches('.ice-turn-step')?'step':'label';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!n.isConnected)return;const m=new DOMMatrix(getComputedStyle(n).transform);window.phaseSamples.push({kind,text:n.textContent,x:m.m41,y:m.m42});}));
    })).observe(document.querySelector('main'),{childList:true,subtree:true});
    window.progressNode=document.querySelector('.ice-turn-progress');
  });
  const policy=async value=>{await page.emulateMedia({reducedMotion:value==='system'?'reduce':'no-preference'});await page.evaluate(value=>{document.documentElement.dataset.reduceMotion=value==='manual'?'true':'false';window.setProgressPolicy(value==='parent'?'always':'user');},value);await frames();};
  for(const [value,phase,label] of [['manual','receiving','模型生成中'],['system','validating','校验输出'],['parent','saving_candidate','保存候选稿'],['normal','tools','执行工具']]){
    await policy(value);await page.evaluate(phase=>window.progressPhase(phase),phase);
    await page.waitForFunction(label=>window.phaseSamples.some(s=>s.kind==='label'&&s.text.includes(label))&&window.phaseSamples.some(s=>s.kind==='step'&&s.text.includes(label)),label);
    const samples=await page.evaluate(label=>window.phaseSamples.filter(s=>s.text.includes(label)),label);report.samples.push({policy:value,samples});
    if(value!=='normal'){
      check(value+'_phase_label_has_no_spatial_motion',samples.filter(s=>s.kind==='label').every(s=>Math.abs(s.x)<.01&&Math.abs(s.y)<.01));
      check(value+'_new_step_has_no_spatial_motion',samples.filter(s=>s.kind==='step').every(s=>Math.abs(s.x)<.01&&Math.abs(s.y)<.01));
      check(value+'_activity_rail_is_static',await page.locator('.ice-activity-rail').getAttribute('data-animated')==='false');
    }
    check(value+'_status_current_step_and_node_are_retained',await page.evaluate(label=>window.progressNode===document.querySelector('.ice-turn-progress')&&document.querySelector('.ice-turn-step[aria-current="step"]').textContent.includes(label)&&document.querySelector('[role="status"]').textContent.includes(label),label));
    check(value+'_narrow_feedback_has_no_horizontal_overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.waitForTimeout(250);
  }
  await page.evaluate(()=>window.setFeedbackVisible(false));await frames();
  check('synthetic_hidden_signal_releases_elapsed_timer',await page.evaluate(()=>window.feedbackStats().timers===0));
  check('synthetic_hidden_signal_pauses_running_feedback',await page.locator('.ice-turn-progress').getAttribute('data-active')==='false'&&await page.locator('.ice-activity-rail').getAttribute('data-animated')==='false');
  const elapsed=await page.locator('.ice-turn-progress__elapsed').innerText();await page.waitForTimeout(1100);
  check('elapsed_text_does_not_tick_while_hidden',await page.locator('.ice-turn-progress__elapsed').innerText()===elapsed);
  await page.evaluate(()=>window.setFeedbackVisible(true));await frames();
  check('visible_signal_resumes_one_timer_with_real_elapsed',await page.evaluate(()=>window.feedbackStats().timers===1)&&await page.locator('.ice-turn-progress__elapsed').innerText()!==elapsed);
  await page.evaluate(()=>window.progressFailure());await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes('生成失败'));await page.waitForTimeout(250);
  const diagnostic=await page.locator('.ice-turn-step--failed').last().getAttribute('title');
  check('failure_step_title_redacts_fixture_credentials',!diagnostic.includes('fixture-progress-value')&&!diagnostic.includes('dXNlcjpwYXNz'));
  check('failure_keeps_useful_reason',diagnostic.includes('受控失败'));
  check('terminal_failure_stops_running_feedback',await page.locator('.ice-turn-progress').getAttribute('data-active')==='false'&&await page.locator('.ice-activity-rail').getAttribute('data-animated')==='false'&&await page.locator('[aria-current="step"]').count()===0);
  check('terminal_failure_releases_elapsed_timer',await page.evaluate(()=>window.feedbackStats().timers===0));
  await page.screenshot({path:path.join(evidence,'progress-failure-narrow.png'),fullPage:true});
  await page.evaluate(()=>window.unmountFeedback());await frames();check('unmount_releases_elapsed_timer_and_visibility_subscriptions',await page.evaluate(()=>window.feedbackStats().timers===0&&window.feedbackStats().listeners===0));
  check('no_renderer_errors',report.errors.length===0);check('source_unchanged_during_run',JSON.stringify(fingerprint())===JSON.stringify(report.sources));
  assert(Object.values(report.checks).every(Boolean),'Failed: '+Object.keys(report.checks).filter(k=>!report.checks[k]).join(', '));
}
run().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({evidence,passed:Object.values(report.checks).filter(Boolean).length,total:Object.keys(report.checks).length,error:report.error}));});
