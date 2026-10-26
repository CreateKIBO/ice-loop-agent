'use strict';
// 批次D13/14（2026-10-20 交互验收补齐）：开发模式 StrictMode 双挂载与清理。
// 装配方式：esbuild 以 conditions:['development'] 打包真实源码组件/hook
// （React 开发运行时；生产构建的 StrictMode 标签不能证明双挂载），由独立 Electron
// 入口加载本地页面；window.__records 记录挂载/清理/RPC 计数，CDP 断言：
// 挂载→清理→重挂载；重挂载后轮询仅一份；卸载后不再调度。
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const esbuild=require('../node_modules/esbuild');
const repo=path.resolve(__dirname,'../..');
const root=repo;
const fixtureRoot=path.join(repo,'.test-tmp','release-strict-mode');
const runId=Date.now().toString(36);
const dir=path.join(fixtureRoot,runId);
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'.test-owner.json'),'{"purpose":"strict mode double mount acceptance"}');
const report={state:'running',scope:'source Electron; React development runtime; real hooks/components; offline local page',checks:{},dir};
const save=()=>fs.writeFileSync(path.join(repo,'docs/上线准备/strict-mode-native.json'),JSON.stringify(report,null,2));

// 真实组件装配（测试专属 wrapper，不修改产品代码）：
// 1) PollingProbe：真实 useEventStream（500ms events.poll 轮询）；
// 2) DelayedFocus：真实 CommandPalette（打开时 setTimeout 延时聚焦 + cleanup）。
const harness=`
import * as React from "react";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { useEventStream } from "./data/client";
import { CommandPalette } from "./app/CommandPalette";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

window.__records={mounts:0,cleanups:0,poll:0,paletteTimers:0,paletteTimerCancels:0,paletteOpens:0};
window.__account="acc-strict";
const store=(window.__iceStore={account:"acc-strict"});
window.ice={
  request:(method,params)=>{ window.__records.poll+= method==="events.poll"?1:0;
    if(method==="chat.list")return [];
    if(method==="jobs.list")return [];
    if(method==="bootstrap")return {version:"test",account:{id:"acc-strict",name:"S"},accounts:[{id:"acc-strict",name:"S"}],settings:{profiles:[],routes:{}}};
    if(method==="events.poll")return {events:[],latest:0};
    return {}; },
};
// 让 client.ts 的账号 store 指向我们的测试账号（真实模块状态）
import("./data/client").then(client=>{
  client.accountStore.set("acc-strict");
  const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
  function PollingProbe(){
    React.useEffect(()=>{window.__records.mounts++;return()=>{window.__records.cleanups++;};},[]);
    const events=useEventStream("chat:conv-strict",true);
    return React.createElement("div",{id:"polling-probe"},"events:"+events.length);
  }
  function DelayedFocus(){
    const [open,setOpen]=React.useState(false);
    return React.createElement("div",null,
      React.createElement("button",{id:"open-palette",onClick:()=>{window.__records.paletteOpens++;setOpen(true);}},"open"),
      React.createElement(CommandPalette,{open,onOpenChange:next=>{if(!next)setOpen(false);}}));
  }
  const root=createRoot(document.getElementById("root"));
  window.__unmount=()=>root.unmount();
  window.__remountPolling=()=>{};
  root.render(React.createElement(StrictMode,null,
    React.createElement(QueryClientProvider,{client:queryClient},
      React.createElement(PollingProbe,null),
      React.createElement(DelayedFocus,null))));
  window.__ready=true;
});
`;

(async()=>{
 try{
  const bundle=esbuild.buildSync({stdin:{contents:harness,resolveDir:path.join(repo,'desktop','ui','src'),loader:'tsx'},bundle:true,write:false,
    format:'iife',platform:'browser',jsx:'automatic',conditions:['development'],
    define:{'process.env.NODE_ENV':'"development"'},
    loader:{'.css':'empty'},logLevel:'silent'});
  fs.writeFileSync(path.join(dir,'harness.js'),bundle.outputFiles[0].text);
  fs.writeFileSync(path.join(dir,'page.html'),'<!doctype html><html><body><div id="root"></div><script src="./harness.js"></script></body></html>');
  const entry=path.join(dir,'entry.cjs');
  fs.writeFileSync(entry,"const {app,BrowserWindow}=require('electron');"+
    "app.whenReady().then(()=>{const win=new BrowserWindow({width:900,height:700,show:false});"+
    `win.loadURL('file:///${path.join(dir,'page.html').replace(/\\\\/g,'/')}');`+
    "win.webContents.on('did-finish-load',()=>setTimeout(()=>app.quit(),25000));});");
  // 用打包入口跑 Electron（不走 native-session——无引擎），经 stdout JSON 取回记录。
  const probe=path.join(dir,'probe.cjs');
  fs.writeFileSync(probe,`const {app,BrowserWindow}=require('electron');
    app.whenReady().then(async()=>{const win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{contextIsolation:false,preload:require('path').join(${JSON.stringify(dir)},'preload.cjs')}});
    win.loadURL('file:///'+${JSON.stringify(path.join(dir,'page.html').replace(/\\\\/g,'/'))});
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const read=async()=>win.webContents.executeJavaScript('JSON.stringify(window.__records||{})');
    await sleep(1500); const early=JSON.parse(await read());
    await sleep(2000); const settled=JSON.parse(await read());
    await win.webContents.executeJavaScript('window.__unmount()');
    await sleep(1500); const afterUnmount=JSON.parse(await read());
    console.log('RESULT'+JSON.stringify({early,settled,afterUnmount}));
    app.quit();});`);
  fs.writeFileSync(path.join(dir,'preload.cjs'),"");
  const out=execFileSync(require('../node_modules/electron'),[probe],{cwd:repo,windowsHide:true,encoding:'utf8',timeout:60000});
  const line=out.split('\n').find(l=>l.startsWith('RESULT'));
  if(!line)throw Error('no RESULT line; stdout='+out.slice(0,400));
  const {early,settled,afterUnmount}=JSON.parse(line.slice(6));
  report.timeline={early,settled,afterUnmount};
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  check('strict_mode_double_mount_observed',settled.mounts>=2&&settled.cleanups>=1);
  // 开发 StrictMode：挂载→清理→重挂载后，轮询节奏应为单份（500ms 一跳，两份会近双倍）
  const delta=settled.poll-early.poll; // ~2s 窗口：单份≈4，双份≈8
  check('single_polling_loop_after_remount',delta>0&&delta<=6);
  check('unmount_stops_scheduling',afterUnmount.poll===settled.poll);
  check('no_leaked_cleanup_deficit',afterUnmount.cleanups>=2);
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})();
