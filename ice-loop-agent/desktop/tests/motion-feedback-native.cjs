"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const esbuild=require('../node_modules/esbuild');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'.test-tmp/release-motion',crypto.randomUUID()),runtime=path.join(root,'runtime');
fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(root,'.test-owner.json'),JSON.stringify({purpose:'actual UI motion/geometry/terminal/cleanup acceptance'}));
const report={state:'running',runtime,root,checks:{},scope:'real React/Motion UI in source Electron; synthetic turn events and document visibility signals; no model or personal workspace'};
const save=()=>{const text=JSON.stringify(report,null,2);fs.writeFileSync(path.join(root,'result.json'),text);fs.writeFileSync(path.join(repo,'docs/上线准备/motion-feedback-native.json'),text);};
const check=(name,ok)=>{assert(ok,name);report.checks[name]=true;save();};
const harness=`
import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {MotionConfig} from 'motion/react';
import {Button} from './components/ui';
import {TurnProgress} from './features/chat/TurnProgress';
const activeTimers=new Map(),listeners=new Set();
const setIntervalReal=window.setInterval.bind(window),clearIntervalReal=window.clearInterval.bind(window);
window.setInterval=(callback,ms,...rest)=>{const id=setIntervalReal(callback,ms,...rest);if(ms===1000)activeTimers.set(id,ms);return id;};
window.clearInterval=id=>{activeTimers.delete(id);clearIntervalReal(id);};
const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
document.addEventListener=(type,listener,...rest)=>{if(type==='visibilitychange')listeners.add(listener);return add(type,listener,...rest);};
document.removeEventListener=(type,listener,...rest)=>{if(type==='visibilitychange')listeners.delete(listener);return remove(type,listener,...rest);};
window.__visible=true;
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__visible?'visible':'hidden'});
const start=()=>[{sequence:1,type:'turn.started',created_at:new Date(Date.now()-5000).toISOString(),payload:{turn_id:'demo'}},{sequence:2,type:'turn.phase',created_at:new Date().toISOString(),payload:{turn_id:'demo',phase:'waiting_model'}}];
function Demo(){
 const [busy,setBusy]=React.useState(false),[events,setEvents]=React.useState(start),[show,setShow]=React.useState(true);
 const calls=React.useRef(0),locked=React.useRef(false);
 const working=()=>{if(locked.current)return;locked.current=true;calls.current++;setBusy(true);};
 React.useLayoutEffect(()=>{window.demo={
  busy:value=>{locked.current=value;setBusy(value);},calls:()=>calls.current,
  stage:phase=>setEvents(previous=>[...previous,{sequence:previous.length+1,type:'turn.phase',created_at:new Date().toISOString(),payload:{turn_id:'demo',phase}}]),
  finish:(status='completed',phase='ready')=>{setBusy(false);locked.current=false;setEvents(previous=>[...previous,{sequence:previous.length+1,type:'turn.finished',created_at:new Date().toISOString(),payload:{turn_id:'demo',status,phase}}]);},
  start:()=>{setEvents(start());setShow(true);},show:setShow,
  visible:value=>{window.__visible=value;document.dispatchEvent(new Event('visibilitychange'));},
  stats:()=>({timers:activeTimers.size,listeners:listeners.size,animations:document.getAnimations().filter(a=>a.playState==='running').length}),
 };});
 return <main style={{maxWidth:820,margin:'0 auto',padding:24,boxSizing:'border-box'}}>
  <span className="ice-eyebrow">ICE LOOP · INTERACTION LAB</span>
  <h1 style={{fontSize:24}}>创作中的每一步，都有回应</h1>
  <p style={{color:'var(--ice-text-secondary)',lineHeight:1.7}}>真实阶段清晰可见，操作反馈保持稳定。这个验收页面使用模拟事件，不会调用模型。</p>
  <section className="ice-card" style={{padding:20,margin:'24px 0'}}>
   <h2 style={{fontSize:16}}>操作反馈</h2>
   <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <Button id="save" variant="primary" loading={busy} onClick={working}>保存为草稿</Button>
    <Button id="secondary" loading={busy} onClick={working}>校验配图资源</Button>
    <Button id="next" onClick={()=>window.demo.finish()}>继续编辑</Button>
   </div>
   <p style={{fontSize:12,color:'var(--ice-text-secondary)',marginBottom:0}}>处理中保留原文字和按钮尺寸，避免误点相邻操作。</p>
  </section>
  <h2 style={{fontSize:16}}>本轮创作</h2>
  {show&&<TurnProgress turnId="demo" events={events} metadata={{progress:{phase:'receiving'}}} />}
 </main>;
}
const root=createRoot(document.getElementById('root'));
window.__unmount=()=>root.unmount();
root.render(<React.StrictMode><MotionConfig reducedMotion="user"><Demo /></MotionConfig></React.StrictMode>);
`;
const bundle=esbuild.buildSync({stdin:{contents:harness,resolveDir:path.join(repo,'desktop/ui/src'),loader:'tsx'},bundle:true,write:false,outdir:root,entryNames:'harness',format:'iife',platform:'browser',jsx:'automatic',conditions:['development'],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
for(const file of bundle.outputFiles)fs.writeFileSync(file.path,file.contents);
fs.writeFileSync(path.join(root,'page.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="ice://app/harness.css"></head><body><div id="root"></div><script src="ice://app/harness.js"></script></body></html>');
const entry=path.join(root,'entry.cjs');
fs.writeFileSync(entry,`const {app,BrowserWindow,protocol,net}=require('electron'),path=require('node:path'),{pathToFileURL}=require('node:url');
app.setPath('userData',path.join(${JSON.stringify(runtime)},'electron'));app.setPath('sessionData',path.join(${JSON.stringify(runtime)},'sessions'));
protocol.registerSchemesAsPrivileged([{scheme:'ice',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{protocol.handle('ice',request=>{const name=path.basename(new URL(request.url).pathname);return net.fetch(pathToFileURL(path.join(${JSON.stringify(root)},name)).href);});
const win=new BrowserWindow({width:1000,height:850,show:true,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadURL('ice://app/page.html');});app.on('window-all-closed',()=>app.quit());`);
let session;
(async()=>{try{
 save();session=await openNativeSession(repo,runtime,{entryPath:entry});const {evaluate,until,call}=session;
 await until('Boolean(window.demo)');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await wait(120);
 const geometry=()=>evaluate(`(()=>{const e=document.querySelector('#save'),r=e.getBoundingClientRect();return {width:r.width,height:r.height,text:e.innerText};})()`);
 const idle=await geometry();
 await evaluate(`document.querySelector('#save').focus()`);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until(`document.querySelector('#save').disabled`);
 const busy=await geometry();report.button_geometry={idle,busy};
 check('loading-preserves-button-width-and-height',Math.abs(idle.width-busy.width)<0.1&&Math.abs(idle.height-busy.height)<0.1);
 check('loading-keeps-visible-label',busy.text==='保存为草稿');
 check('keyboard-action-runs-once',await evaluate('window.demo.calls()===1'));
 check('pending-has-native-disabled-and-busy',await evaluate(`document.querySelector('#save').disabled&&document.querySelector('#save').getAttribute('aria-busy')==='true'`));
 await evaluate(`document.querySelector('#save').click();document.querySelector('#save').click()`);
 check('disabled-loading-does-not-repeat-action',await evaluate('window.demo.calls()===1'));
 const transform=()=>evaluate(`getComputedStyle(document.querySelector('#save .ice-activity-rail__fill')).transform`);
 const first=await transform();await wait(250);const second=await transform();
 report.normal_motion={first,second,dom:await evaluate(`({pref:matchMedia('(prefers-reduced-motion:reduce)').matches,animated:document.querySelector('#save .ice-activity-rail').dataset.animated,animations:document.getAnimations().map(a=>({state:a.playState,time:a.currentTime,frames:a.effect?.getKeyframes()}))})`)};save();
 check('library-indeterminate-animation-actually-moves',first!==second);
 check('only-one-progress-clock-after-strict-replay',await evaluate('window.demo.stats().timers===1'));
 await evaluate(`window.demo.stage('validating')`);await until(`document.querySelector('.ice-turn-progress__label')?.innerText==='校验输出'`);
 check('real-stage-label-updates',true);
 check('elapsed-is-outside-live-announcement',await evaluate(`!document.querySelector('.ice-turn-progress [role="status"] .ice-turn-progress__elapsed')`));
 await evaluate('window.demo.visible(false)');await until('window.demo.stats().timers===0');
 check('hidden-document-stops-clock',true);
 await until(`[...document.querySelectorAll('.ice-activity-rail')].every(e=>e.dataset.animated==='false')`);
 check('hidden-document-stops-motion-loops',true);
 check('hidden-document-stops-css-typing-pulse',await evaluate(`[...document.querySelectorAll('.ice-turn-progress .ice-typing > span,.ice-turn-progress .ice-turn-step__dot')].every(e=>getComputedStyle(e).animationName==='none')`));
 await evaluate('window.demo.visible(true)');await until('window.demo.stats().timers===1');check('visible-document-resumes-one-clock',true);
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await until(`[...document.querySelectorAll('.ice-activity-rail')].every(e=>e.dataset.animated==='false')`);
 const still=await transform();await wait(230);check('reduced-motion-is-static-not-slow-repeat',still===await transform());
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await until(`document.querySelector('#save .ice-activity-rail').dataset.animated==='true'`);
 const resumed=await transform();await wait(240);check('system-motion-change-resumes-current-indicator',resumed!==await transform());
 await evaluate(`document.documentElement.dataset.reduceMotion='true'`);
 await until(`document.querySelector('#save .ice-activity-rail').dataset.animated==='false'`);
 const manual=await transform();await wait(100);check('manual-reduced-motion-also-stops-library-loop',manual===await transform());
 await evaluate(`delete document.documentElement.dataset.reduceMotion`);

 await evaluate('window.demo.finish()');await until(`document.querySelector('.ice-turn-progress__label')?.innerText==='完成'&&window.demo.stats().timers===0`);
 check('finish-overrides-stale-generating-metadata',true);
 check('finished-progress-no-typing-or-active-step',await evaluate(`!document.querySelector('.ice-turn-progress .ice-typing')&&!document.querySelector('.ice-turn-step--active')`));
 check('finished-progress-keeps-real-duration',await evaluate(`document.querySelector('.ice-turn-progress__elapsed')?.innerText.startsWith('用时')`));
 for(const [status,phase,label,tone] of [['failed','','生成失败','danger'],['stopped','','已停止','warning'],['completed','awaiting_input','等待你回答','warning']]){
  await evaluate('window.demo.start()');await evaluate(`window.demo.finish(${JSON.stringify(status)},${JSON.stringify(phase)})`);
  await until(`document.querySelector('.ice-turn-progress__label')?.innerText===${JSON.stringify(label)}`);
  check('terminal-'+(phase||status),await evaluate(`document.querySelector('.ice-turn-progress').dataset.tone===${JSON.stringify(tone)}&&window.demo.stats().timers===0`));
 }
 for(const width of [500,1000]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
  check('no-horizontal-overflow-'+width,await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 }
 await evaluate('window.demo.start()');await evaluate('window.demo.busy(true)');await wait(70);
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await wait(120);
 const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'motion-feedback.png'),Buffer.from(screenshot.data,'base64'));
 await evaluate('window.demo.busy(false);window.demo.show(false)');await until('window.demo.stats().timers===0');await wait(120);
 const warm=await evaluate('window.demo.stats()');
 for(let i=0;i<12;i++){await evaluate('window.demo.start();window.demo.busy(true)');await wait(20);await evaluate('window.demo.show(false);window.demo.busy(false)');await wait(20);}
 const settled=await evaluate('window.demo.stats()');report.cleanup={warm,settled,cycles:12};
 check('repeated-mount-does-not-accumulate-visibility-listeners',settled.listeners<=warm.listeners);
 check('repeated-mount-stops-all-progress-clocks',settled.timers===0);
 await evaluate('window.__unmount()');await wait(220);
 check('root-unmount-leaves-no-clock-or-motion',await evaluate('window.demo.stats().timers===0&&document.getAnimations().filter(a=>a.playState==="running").length===0'));
 check('no-uncaught-ui-errors',session.errors.length===0);
 report.state='finished';report.success=true;save();console.log(JSON.stringify({state:report.state,checks:Object.keys(report.checks).length,root}));
 }catch(error){report.state='failed';report.error=error.stack;save();console.error(error);process.exitCode=1;}
 finally{if(session)await session.close();}
})();
