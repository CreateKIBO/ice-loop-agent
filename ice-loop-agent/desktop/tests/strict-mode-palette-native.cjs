'use strict';
// 批次B1/B2（2026-10-21 后续工程）：StrictMode 下真实打开命令面板并观测其焦点计时器。
// 旧 strict-mode-native 只证明轮询清理（paletteOpens=0，面板从未打开）。本专项：
// - esbuild conditions:['development'] + NODE_ENV=development 装配真实 CommandPalette
//   与真实 ui.tsx Dialog（React 开发运行时，StrictMode 双挂载真实生效）；
// - window.setTimeout/clearTimeout 仅做转发观测（照常调用原实现，不无条件打桩、
//   不改产品延时）：记录 schedule/cancel/fire；cancelWhilePending 标记“计时器尚未
//   触发时就被 clearTimeout”的真实取消——StrictMode 挂载重放给出确定性样本；
// - B3 组件级契约：旧 opener 被移除/禁用时关闭弹窗的安全退让、关闭旧弹窗立即
//   打开新弹窗时焦点不归还旧 opener（Codex ui.tsx 修复的受控复验）。
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const esbuild=require('../node_modules/esbuild');
const repo=path.resolve(__dirname,'../..');
const dir=path.join(repo,'.test-tmp','release-strict-mode-palette',Date.now().toString(36));
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'.test-owner.json'),'{"purpose":"strict mode palette focus timers acceptance"}');
const report={state:'running',scope:'source Electron; React development runtime; real CommandPalette/Dialog; forwarded real timers',checks:{},dir,stages:{}};
const save=()=>fs.writeFileSync(path.join(repo,'docs/上线准备/strict-mode-palette-native.json'),JSON.stringify(report,null,2));

const harness=`
import * as React from "react";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { useEventStream } from "./data/client";
import { CommandPalette } from "./app/CommandPalette";
import { Dialog } from "./components/ui";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// —— 转发观测（测试专属，不改变任何时序）：照常调用原实现，仅记录。 ——
window.__realSetTimeout = window.setTimeout.bind(window);
window.__realClearTimeout = window.clearTimeout.bind(window);
window.__records={mounts:0,cleanups:0,poll:0,paletteOpens:0,
  timerScheduled:0,focusTimerScheduled:0,timerCancelled:0,cancelWhilePending:0,cancelFocusWhilePending:0,
  timerFired:0,focusTimerFired:0,focusFiredAfterUnmount:0,unmountedAt:0,errors:[]};
window.addEventListener('error',e=>window.__records.errors.push(String(e.message)));
const pending=new Map();
const isPaletteFocusTimer=fn=>typeof fn==='function'&&Function.prototype.toString.call(fn).includes('inputRef.current');
window.setTimeout=function(fn,delay,...rest){
  const focus=isPaletteFocusTimer(fn);
  const callback=typeof fn==='function'?function(...args){
    pending.delete(id);window.__records.timerFired++;
    if(focus){window.__records.focusTimerFired++;
      if(window.__records.unmountedAt>0)window.__records.focusFiredAfterUnmount++;}
    return Reflect.apply(fn,this,args);
  }:fn;
  const id=window.__realSetTimeout(callback,delay,...rest);
  pending.set(id,focus);window.__records.timerScheduled++;
  if(focus)window.__records.focusTimerScheduled++;
  return id;
};
window.clearTimeout=function(id){
  if(pending.has(id)){
    if(pending.get(id))window.__records.cancelFocusWhilePending++;
    pending.delete(id);window.__records.cancelWhilePending++;
  }
  window.__records.timerCancelled++;
  return window.__realClearTimeout(id);
};

window.__account="acc-strict";
window.ice={
  request:(method)=>{ window.__records.poll+= method==="events.poll"?1:0;
    if(method==="chat.list")return [];
    if(method==="jobs.list")return [];
    if(method==="bootstrap")return {version:"test",account:{id:"acc-strict",name:"S"},accounts:[{id:"acc-strict",name:"S"}],settings:{profiles:[],routes:{}}};
    if(method==="events.poll")return {events:[],latest:0};
    return {}; },
};
import("./data/client").then(client=>{
  client.accountStore.set("acc-strict");
  const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
  function PollingProbe(){
    React.useEffect(()=>{window.__records.mounts++;return()=>{window.__records.cleanups++;};},[]);
    const events=useEventStream("chat:conv-strict",true);
    return React.createElement("div",{id:"polling-probe"},"events:"+events.length);
  }
  // 真实 CommandPalette：初始 open（StrictMode 挂载重放给出确定性的“排程后未触发即被清理”），
  // 之后全部走真实点击的用户路径。
  function PaletteHost(){
    const [open,setOpen]=React.useState(true);
    return React.createElement("div",null,
      React.createElement("button",{id:"open-palette",onClick:()=>{window.__records.paletteOpens++;setOpen(true);}},"open"),
      React.createElement("button",{id:"close-palette",onClick:()=>setOpen(false)},"close"),
      React.createElement("input",{id:"palette-opener","aria-label":"面板触发输入"}),
      React.createElement(CommandPalette,{open,onOpenChange:next=>{if(!next)setOpen(false);}}));
  }
  // B3 组件级契约：openerState 支持移除/禁用后经 reset 复位，供多阶段复用。
  function GuardHost(){
    const [a,setA]=React.useState(false),[b,setB]=React.useState(false);
    const [openerState,setOpenerState]=React.useState("normal");
    return React.createElement("div",{id:"guard"},
      openerState!=="removed"?React.createElement("button",{id:"a-open",disabled:openerState==="disabled",onClick:()=>setA(true)},"openA"):null,
      React.createElement("button",{id:"b-open",onClick:()=>setB(true)},"openB"),
      React.createElement("button",{id:"remove-opener",onClick:()=>setOpenerState("removed")},"removeOpener"),
      React.createElement("button",{id:"disable-opener",onClick:()=>setOpenerState("disabled")},"disableOpener"),
      React.createElement("button",{id:"reset-opener",onClick:()=>setOpenerState("normal")},"resetOpener"),
      React.createElement(Dialog,{open:a,onOpenChange:next=>{if(!next)setA(false);},title:"A 弹窗"},
        React.createElement("button",{id:"a-close",onClick:()=>setA(false)},"closeA")),
      React.createElement(Dialog,{open:b,onOpenChange:next=>{if(!next)setB(false);},title:"B 弹窗"},
        React.createElement("button",{id:"b-close",onClick:()=>setB(false)},"closeB")));
  }
  const root=createRoot(document.getElementById("root"));
  window.__unmount=()=>{window.__records.unmountedAt=performance.now();root.unmount();};
  root.render(React.createElement(StrictMode,null,
    React.createElement(QueryClientProvider,{client:queryClient},
      React.createElement(PollingProbe,null),
      React.createElement(PaletteHost,null),
      React.createElement(GuardHost,null))));
  window.__ready=true;
});
`;

// 分阶段页面脚本（页内等待用 __realSetTimeout，避免污染观测计数）；每段返回 JSON。
const wait=ms=>`await new Promise(r=>window.__realSetTimeout(r,${ms}));`;
const steps={
  timer_contract:`return JSON.stringify(await new Promise(resolve=>window.setTimeout(function(a,b){resolve({args:[a,b],windowThis:this===window})},0,'alpha',7)))`,
  settle:`${wait(400)}return JSON.stringify({records:window.__records,paletteFocused:document.activeElement?.getAttribute('aria-label')==='搜索命令'})`,
  user_close:`document.querySelector('#close-palette').click();${wait(180)}return JSON.stringify({records:window.__records,bodyFocused:document.activeElement===document.body})`,
  user_reopen_close:`document.querySelector('#palette-opener').focus();
    document.querySelector('#open-palette').click();${wait(180)}
    const focusedInPalette=document.activeElement?.getAttribute('aria-label')==='搜索命令';
    document.querySelector('#close-palette').click();${wait(180)}
    return JSON.stringify({records:window.__records,focusedInPalette,backOnOpener:document.activeElement?.id==='palette-opener'})`,
  rapid_toggle:`const t0=performance.now();
    document.querySelector('#open-palette').click();${wait(90)}
    document.querySelector('#close-palette').click();${wait(90)}
    document.querySelector('#open-palette').click();${wait(280)}
    const t1=performance.now();
    return JSON.stringify({records:window.__records,elapsedMs:t1-t0,
      paletteInputs:[...document.querySelectorAll('[aria-label="搜索命令"]')].map(n=>({connected:n.isConnected,focused:document.activeElement===n})),
      dialogs:[...document.querySelectorAll('[role="dialog"]')].length})`,
  guard_jump:`document.querySelector('#close-palette').click();${wait(120)}
    document.querySelector('#a-open').focus();document.querySelector('#a-open').click();${wait(150)}
    const aFocusInDialog=document.querySelector('[role="dialog"]')?.contains(document.activeElement);
    // 关 A 后立即开 B（同任务）：B 必须保有焦点，不归还 A 的 opener。
    document.querySelector('#a-close').click();document.querySelector('#b-open').click();${wait(180)}
    const bDialog=[...document.querySelectorAll('[role="dialog"]')].find(d=>d.innerText.includes('B 弹窗'));
    return JSON.stringify({aFocusInDialog,bOpen:Boolean(bDialog),bHasFocus:Boolean(bDialog?.contains(document.activeElement))})`,
  guard_removed:`document.querySelector('#b-close').click();${wait(120)}
    document.querySelector('#reset-opener').click();${wait(60)}
    document.querySelector('#a-open').focus();
    const openerWasFocused=document.activeElement?.id==='a-open';
    document.querySelector('#a-open').click();${wait(150)}
    document.querySelector('#remove-opener').click();
    document.querySelector('#a-close').click();${wait(150)}
    return JSON.stringify({openerWasFocused,removedGone:!document.querySelector('#a-open'),focusOnBody:document.activeElement===document.body,errors:window.__records.errors})`,
  guard_disabled:`document.querySelector('#reset-opener').click();${wait(60)}
    document.querySelector('#a-open').focus();
    const openerWasFocused=document.activeElement?.id==='a-open';
    document.querySelector('#a-open').click();${wait(150)}
    document.querySelector('#disable-opener').click();
    document.querySelector('#a-close').click();${wait(150)}
    return JSON.stringify({openerWasFocused,openerDisabled:Boolean(document.querySelector('#a-open')?.disabled),focusOnBody:document.activeElement===document.body,errors:window.__records.errors})`,
  unmount_open:`document.querySelector('#open-palette').click();${wait(180)}
    const beforeUnmount={open:Boolean(document.querySelector('[aria-label="搜索命令"]')),focused:document.activeElement?.getAttribute('aria-label')==='搜索命令'};
    const pollBefore=window.__records.poll;window.__unmount();${wait(350)}return JSON.stringify({records:window.__records,beforeUnmount,pollBefore,pollAfter:window.__records.poll,bodyFocused:document.activeElement===document.body||document.activeElement===null,anyDialog:Boolean(document.querySelector('[role="dialog"]'))})`,
};

(async()=>{
 let child=null;
 try{
  const bundle=esbuild.buildSync({stdin:{contents:harness,resolveDir:path.join(repo,'desktop','ui','src'),loader:'tsx'},bundle:true,write:false,
    format:'iife',platform:'browser',jsx:'automatic',conditions:['development'],
    define:{'process.env.NODE_ENV':'"development"'},
    loader:{'.css':'empty'},logLevel:'silent'});
  fs.writeFileSync(path.join(dir,'harness.js'),bundle.outputFiles[0].text);
  fs.writeFileSync(path.join(dir,'page.html'),'<!doctype html><html><body><div id="root"></div><script src="./harness.js"></script></body></html>');
  const probeCode=`
const {app,BrowserWindow}=require('electron');
const path=require('path');
const dir=${JSON.stringify(dir)};
(async()=>{try{
  // 本轮自有隔离目录承载 userData/sessionData（不落个人目录）。
  app.setPath('userData',path.join(dir,'electron-data'));
  app.setPath('sessionData',path.join(dir,'electron-session'));
  await app.whenReady();
  const win=new BrowserWindow({width:1000,height:800,show:false,webPreferences:{contextIsolation:false}});
  win.webContents.on('console-message',(_e,_l,message)=>{if(!message.includes('Autofill'))console.log('PAGE '+message.slice(0,300));});
  win.webContents.on('render-process-gone',(_e,details)=>console.log('GONE '+JSON.stringify(details)));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await win.loadURL('file:///'+path.join(dir,'page.html').replace(/\\\\/g,'/'));
  const run=js=>win.webContents.executeJavaScript('(async()=>{'+js+'})()');
  await sleep(700);
  const stages={};
  const order=${JSON.stringify(Object.keys(steps))};
  const scripts=${JSON.stringify(steps)};
  for(const name of order){try{stages[name]=JSON.parse(await run(scripts[name]));}
    catch(e){console.error('PROBE_FAIL stage='+name+' '+(e&&e.message||e));app.exit(2);return;}}
  console.log('STAGES '+JSON.stringify(stages));
  app.quit();
}catch(e){console.error('PROBE_FAIL '+e.stack);app.exit(1);}})();`;
  const probe=path.join(dir,'probe.cjs');
  fs.writeFileSync(probe,probeCode);
  child=spawn(require('../node_modules/electron'),[probe],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TEMP:dir,TMP:dir}});
  let out='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('probe timeout (45s)')),45000);
    child.stdout.on('data',d=>{out+=d;if(out.includes('STAGES '))clearTimeout(timer),resolve();});
    child.stderr.on('data',d=>{out+=d;});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('probe exited '+code+': '+out.slice(-800)));});
  });
  const line=out.split('\n').find(l=>l.startsWith('STAGES '));
  if(!line)throw Error('no STAGES line; stdout='+out.slice(0,600));
  const stages=JSON.parse(line.slice(7));
  report.stages=stages;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const r0=stages.settle.records,rc=stages.user_close.records,
        rr2=stages.user_reopen_close.records,rr=stages.rapid_toggle.records,ru=stages.unmount_open.records;
  // B1：StrictMode 挂载重放下，面板真实打开且命令输入框真实聚焦（paletteOpens 旧专项为 0）。
  check('timer_observer_preserves_callback_arguments_and_this',stages.timer_contract.windowThis===true&&JSON.stringify(stages.timer_contract.args)===JSON.stringify(['alpha',7]));
  check('palette_opened_input_focused',stages.settle.paletteFocused===true);
  // B1/B2：真实转发的计时器——挂载重放期间出现“尚未触发即被 clearTimeout”。
  check('timers_forwarded_and_observed',r0.timerScheduled>0&&r0.focusTimerScheduled>=2&&r0.cancelFocusWhilePending>=1&&r0.focusTimerFired>=1);
  // B2：用户路径打开的面板经真实 setTimeout 聚焦；关闭后焦点归还真实 opener。
  check('user_open_focuses_via_real_timer',stages.user_reopen_close.focusedInPalette===true);
  check('close_returns_focus_to_opener',stages.user_reopen_close.backOnOpener===true&&rc.timerCancelled>r0.timerCancelled);
  // B2：快速开-关-开——只有当前面板获得焦点；输入框唯一、已连接且聚焦。
  check('rapid_toggle_single_live_palette',stages.rapid_toggle.dialogs===1&&stages.rapid_toggle.paletteInputs.length===1&&stages.rapid_toggle.paletteInputs[0].connected&&stages.rapid_toggle.paletteInputs[0].focused);
  // B2：区分 StrictMode 初始重放与后续状态更新：初始挂载排程≥2；此后每次用户打开仅 +1。
  check('strict_replay_vs_updates_distinguished',r0.focusTimerScheduled>=2&&(rr.focusTimerScheduled-rr2.focusTimerScheduled)===2);
  // B2：打开态卸载——被移除的输入框不再获得焦点、不残留弹窗、卸载后无排程漂移。
  check('unmount_started_with_open_focused_palette',stages.unmount_open.beforeUnmount.open&&stages.unmount_open.beforeUnmount.focused);
  check('unmount_does_not_focus_removed_node',stages.unmount_open.bodyFocused===true&&stages.unmount_open.anyDialog===false&&ru.focusFiredAfterUnmount===0);
  check('unmount_stops_scheduling',stages.unmount_open.pollAfter===stages.unmount_open.pollBefore&&ru.cleanups>=2);
  // B3：关 A 立即开 B——B 保有焦点（不归还 A 的 opener；无全局焦点劫持）。
  check('close_then_jump_keeps_new_dialog_focus',stages.guard_jump.aFocusInDialog===true&&stages.guard_jump.bOpen===true&&stages.guard_jump.bHasFocus===true);
  // B3：旧 opener 已移除——关闭后落到 body，不聚焦已移除节点，无页面异常。
  check('removed_opener_safe_fallback',stages.guard_removed.openerWasFocused===true&&stages.guard_removed.removedGone===true&&stages.guard_removed.focusOnBody===true&&(stages.guard_removed.errors||[]).length===0);
  // B3：旧 opener 已禁用——关闭后不聚焦禁用控件。
  check('disabled_opener_not_focused',stages.guard_disabled.openerWasFocused===true&&stages.guard_disabled.openerDisabled===true&&stages.guard_disabled.focusOnBody===true);
  // 旧 strict-mode 语义保留：重挂载后轮询单份。
  check('polling_continues_across_dialogs',rr.poll>0&&(rr.poll-rc.poll)>0);
  check('no_page_errors',(ru.errors||[]).length===0);
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{
  if(child&&child.exitCode===null){
    await new Promise(resolve=>{const timer=setTimeout(resolve,4000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    if(child.exitCode===null)await new Promise(resolve=>{
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
      killer.once('error',resolve);killer.once('exit',resolve);
    });
  }
  save();
 }
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})();
