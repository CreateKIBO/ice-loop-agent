'use strict';
// 批A4（2026-10-25）：CopyButton 修复（R2）的真实组件旅程。
// esbuild 装配真实 CopyButton/Button/toast（React 开发运行时），独立 Electron 页面，
// window.ice.copyText 由 __plan 脚本化（ok:true / ok:false / throw / delay），逐段驱动：
// 成功→失败、失败→成功、连续两次成功、请求途中换 text、同 tick 三连点、卸载后无按钮残留。
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const esbuild=require('../node_modules/esbuild');
const repo=path.resolve(__dirname,'../..');
const dir=path.join(repo,'.test-tmp','release-copy-button',Date.now().toString(36));
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'.test-owner.json'),'{"purpose":"CopyButton feedback state acceptance"}');
const report={state:'running',scope:'source Electron; real CopyButton/toast; scripted bridge adapter',checks:{},dir,stages:{}};
const save=()=>fs.writeFileSync(path.join(repo,'docs/上线准备/copy-button-native.json'),JSON.stringify(report,null,2));

const harness=`
import * as React from "react";
import { createRoot } from "react-dom/client";
import { CopyButton } from "./components/CopyButton";
import { Toaster } from "./components/toast";

window.__plan=[];
window.__calls=[];
window.ice={copyText:async text=>{
  window.__calls.push(text);
  const step=window.__plan.shift()||{ok:true};
  if(step.delay)await new Promise(r=>setTimeout(r,step.delay));
  if(step.throw)throw Error(step.throw);
  return step;
}};
function Host(){
  const [text,setText]=React.useState("第一段完整内容");
  const [mounted,setMounted]=React.useState(true);
  return React.createElement(React.Fragment,null,
    React.createElement("input",{id:"text-source",value:text,onChange:e=>setText(e.target.value),"aria-label":"待复制文本"}),
    mounted?React.createElement("span",{id:"copy-host"},React.createElement(CopyButton,{text,label:"复制内容",successLabel:"已复制"})):null,
    React.createElement("button",{id:"unmount-toggle",onClick:()=>setMounted(v=>!v)},"toggle"),
    React.createElement(Toaster,null));
}
let __err='';
try{createRoot(document.getElementById("root")).render(React.createElement(Host,null));}catch(e){__err=String(e&&e.stack||e);}
window.__err=__err;
`;
const btn=`(document.getElementById('copy-host')||{}).querySelector?.('button')`;
const wait=ms=>`await new Promise(r=>setTimeout(r,${ms}));`;
const steps={
  ready:`${wait(500)}return JSON.stringify({err:(window.__err||'').slice(0,200),btn:Boolean(${btn})})`,
  success_then_failure:`window.__plan=[{ok:true}];${btn}.click();${wait(400)}
    const afterSuccess=${btn}.innerText;
    window.__plan=[{ok:false,message:'内存拒绝A'}];${btn}.click();${wait(500)}
    return JSON.stringify({afterSuccess,afterFailure:${btn}.innerText,disabled:${btn}.disabled,failToast:[...document.querySelectorAll('.ice-toast')].some(t=>t.innerText.includes('内存拒绝A'))})`,
  failure_then_success:`window.__plan=[{throw:'桥接异常B'}];${btn}.click();${wait(400)}
    const mid=${btn}.innerText;
    window.__plan=[{ok:true}];${btn}.click();${wait(400)}
    return JSON.stringify({mid,after:${btn}.innerText})`,
  two_success_in_row:`window.__plan=[{ok:true},{ok:true}];${btn}.click();${wait(300)}
    const first=${btn}.innerText;${btn}.click();${wait(400)}
    return JSON.stringify({first,second:${btn}.innerText})`,
  text_change_midflight:`window.__plan=[{delay:700,ok:true}];${btn}.click();${wait(100)}
    const box=document.getElementById('text-source');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(box,'第二段新内容');
    box.dispatchEvent(new Event('input',{bubbles:true}));
    ${wait(900)}
    return JSON.stringify({calls:JSON.stringify(window.__calls),copied:${btn}.innerText.includes('已复制')})`,
  triple_click_same_tick:`const before=window.__calls.length;window.__plan=[{delay:600,ok:true}];${btn}.click();${btn}.click();${btn}.click();${wait(900)}
    return JSON.stringify({callsDelta:window.__calls.length-before,copied:${btn}.innerText.includes('已复制')})`,
  repeated_success_expires_from_latest:`window.__plan=[{ok:true},{ok:true}];${btn}.click();${wait(1300)}
    ${btn}.click();${wait(700)}const stillCurrent=${btn}.innerText.includes('已复制');${wait(1250)}
    return JSON.stringify({stillCurrent,expired:!${btn}.innerText.includes('已复制')})`,
  text_roundtrip_midflight:`const box=document.getElementById('text-source'),original=box.value;
    window.__plan=[{delay:800,ok:true}];${btn}.click();${wait(80)}
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(box,'临时不同内容');box.dispatchEvent(new Event('input',{bubbles:true}));${wait(80)}
    set.call(box,original);box.dispatchEvent(new Event('input',{bubbles:true}));${wait(1000)}
    return JSON.stringify({copied:${btn}.innerText.includes('已复制')})`,
  unmount:`window.__plan=[{ok:true}];${btn}.click();${wait(300)}
    document.getElementById('unmount-toggle').click();${wait(2000)}
    return JSON.stringify({buttonGone:!Boolean(${btn})})`,
  pending_unmount_failure:`document.getElementById('unmount-toggle').click();${wait(150)}
    window.__plan=[{delay:600,ok:false,message:'卸载后不应出现的失败'}];${btn}.click();${wait(80)}
    document.getElementById('unmount-toggle').click();${wait(850)}
    return JSON.stringify({lateToast:[...document.querySelectorAll('.ice-toast')].some(t=>t.textContent.includes('卸载后不应出现的失败'))})`,
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
  const probeCode=[
    "const {app,BrowserWindow}=require('electron');",
    "const path=require('path');const fs=require('fs');",
    `const dir=${JSON.stringify(dir)};`,
    "(async()=>{try{",
    "  app.setPath('userData',path.join(dir,'electron-data'));app.setPath('sessionData',path.join(dir,'electron-session'));",
    "  await app.whenReady();",
    "  const trace=fs.createWriteStream(path.join(dir,'trace.log'));",
    "  const win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{contextIsolation:false}});",
    "  win.webContents.on('console-message',(_e,_l,m)=>{trace.write(String(m)+String.fromCharCode(10));});",
    "  await win.loadURL('file:///'+path.join(dir,'page.html').replace(/\\\\/g,'/'));",
    "  const sleep=ms=>new Promise(r=>setTimeout(r,ms));await sleep(600);",
    `  const order=${JSON.stringify(Object.keys(steps))};`,
    `  const scripts=${JSON.stringify(steps)};`,
    "  const stages={};",
    "  for(const name of order){trace.write('AT '+name+String.fromCharCode(10));stages[name]=JSON.parse(await win.webContents.executeJavaScript('(async()=>{'+scripts[name]+'})()'));}",
    "  console.log('STAGES '+JSON.stringify(stages));",
    "  trace.end();app.quit();",
    "}catch(e){console.error('PROBE_FAIL '+((e&&e.stack)||e));await new Promise(r=>setTimeout(r,200));app.exit(1);}})();",
  ].join('\n');
  const probe=path.join(dir,'probe.cjs');
  fs.writeFileSync(probe,probeCode);
  child=spawn(require('../node_modules/electron'),[probe],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('probe timeout')),45000);
    child.stdout.on('data',d=>{out+=d;if(out.includes('STAGES '))clearTimeout(timer),resolve();});
    child.stderr.on('data',d=>{out+=d;});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('probe exited '+code+': '+out.slice(-600)));});
  });
  const line=out.split('\n').find(l=>l.startsWith('STAGES '));
  if(!line)throw Error('no STAGES: '+out.slice(0,400));
  const stages=JSON.parse(line.slice(7));
  report.stages=stages;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  check('harness_mounts_real_component',stages.ready.err===''&&stages.ready.btn===true);
  check('success_then_failure_clears_old_success',
    stages.success_then_failure.afterSuccess.includes('已复制')
    && !stages.success_then_failure.afterFailure.includes('已复制')
    && stages.success_then_failure.disabled===false
    && stages.success_then_failure.failToast===true);
  check('failure_then_success_shows_current_result',
    !stages.failure_then_success.mid.includes('已复制')
    && stages.failure_then_success.after.includes('已复制'));
  check('two_success_in_row_each_shows_success',
    stages.two_success_in_row.first.includes('已复制')&&stages.two_success_in_row.second.includes('已复制'));
  check('text_change_midflight_not_marked_copied',
    stages.text_change_midflight.calls.includes('第一段完整内容')
    && stages.text_change_midflight.copied===false);
  check('triple_click_single_operation',stages.triple_click_same_tick.callsDelta===1&&stages.triple_click_same_tick.copied===true);
  check('repeated_success_expires_from_latest',stages.repeated_success_expires_from_latest.stillCurrent&&stages.repeated_success_expires_from_latest.expired);
  check('text_roundtrip_invalidates_old_operation',!stages.text_roundtrip_midflight.copied);
  check('unmount_removes_button',stages.unmount.buttonGone===true);
  check('unmounted_failure_does_not_notify',!stages.pending_unmount_failure.lateToast);
  report.state='finished';
 }catch(error){report.state='failed';report.error=String((error&&error.stack)||error);}
 finally{
  if(child&&child.exitCode===null){try{spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}}
  save();
 }
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})();
