'use strict';
// 批A6/B2（2026-10-23 体验完善）：新增行为的真实路径证据。
// 复用 interaction-lists 真实引擎夹具（新 seed）：欢迎页入门清单的状态徽章/收起/
// 重开/账号偏好持久化；会话头部的写作模型与“未关联期号”说明。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction fixture required');
const report={state:'running',scope:'source Electron; real engine fixture; offline',checks:{},runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'start-guide-native.json'),JSON.stringify(report,null,2));
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const VK={Enter:13,k:75};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  // 测试隔离：等应用就绪后清跨运行保留的 UI 状态键（含上次选中会话），
  // 再经真实用户路径（命令面板「开始指南」）回到欢迎页，不做页面重载。
  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
  await evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('ice.ui.')||k.startsWith('ice.composer.')).forEach(k=>localStorage.removeItem(k));`);
  await key('k',2);
  await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await call('Input.insertText',{text:'开始指南'});
  await key('Enter');
  await until(`!document.querySelector('[aria-label="搜索命令"]')`);

  // ---------- A6：欢迎页入门清单 ----------
  const guide=`document.querySelector('section[aria-label="开始指南"]')`;
  await until(`Boolean(${guide})`);
  check('guide_visible_on_welcome',true);
  check('guide_items_have_observable_status',await evaluate(`${guide}.querySelectorAll('.ice-badge').length>=3`));
  // 模型未就绪（离线夹具无 verified Key）时第 2 项必须是“待处理”，不伪造完成。
  check('model_step_not_faked_ready',await evaluate(`[...${guide}.querySelectorAll('li')][1].innerText.includes('待处理')`));
  const toggle=`[...${guide}.querySelectorAll('button')].find(b=>b.innerText.includes('收起清单'))`;
  await until(`Boolean(${toggle})`);
  await evaluate(`(${toggle}).click()`);
  await until(`${guide}&&${guide}.querySelector('ol')===null`);
  check('collapse_hides_steps',true);
  // 用户视角验收：收起后进入会话，再经命令面板“开始指南”返回——清单应保持收起。
  await evaluate(`document.querySelector('.ice-nav-row__main').focus()`);
  await key('Enter');
  await until(`!document.querySelector('section[aria-label="开始指南"]')`);
  await key('k',2);
  await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await call('Input.insertText',{text:'开始指南'});
  await key('Enter');
  await until(`Boolean(document.querySelector('section[aria-label="开始指南"]'))`);
  await wait(400);
  report.persist=await evaluate(`'ol='+(Boolean(document.querySelector('section[aria-label="开始指南"] ol')))+' expanded='+document.querySelector('section[aria-label="开始指南"] [aria-expanded]')?.getAttribute('aria-expanded')+' ls='+JSON.stringify(Object.keys(localStorage).filter(k=>k.includes('startcheck')))`);save();
  check('dismissed_pref_persisted',await evaluate(`document.querySelector('section[aria-label="开始指南"] [aria-expanded]')?.getAttribute('aria-expanded')==='false'`));
  const reopen=`[...${guide}.querySelectorAll('button')].find(b=>b.innerText.includes('重新打开清单'))`;
  await until(`Boolean(${reopen})`);
  await evaluate(`${reopen}.click()`);
  await until(`Boolean(${guide}?.querySelector('ol'))`);
  check('reopen_restores_steps',true);

  // ---------- B2：会话头部上下文 ----------
  await evaluate(`document.querySelector('.ice-nav-row__main').focus()`);
  await key('Enter');
  await until(`Boolean(document.querySelector('.ice-conversation-header h1')?.textContent.trim())`);
  const header=`document.querySelector('.ice-conversation-header__identity')`;
  check('header_shows_writer_model',await evaluate(`${header}.innerText.includes('写作模型：')`));
  check('header_shows_unlinked_notice',await evaluate(`${header}.innerText.includes('未关联期号')`));

  check('no_renderer_exceptions',session.errors.length===0);
  report.state='finished';
 }catch(error){report.state='failed';report.error=String((error&&error.stack)||error);}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
