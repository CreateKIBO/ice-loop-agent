'use strict';
// 批G（2026-10-25 界面体验打磨）：本轮增量与关键复用能力的真实路径验证。
// 复用 interaction-lists 真实引擎夹具（新 seed）。覆盖：
// - 复用证据：编辑器文章目录（真实 AST 标题）、修改审阅空态、下载箱刷新入口；
// - 本轮增量：提示词“未保存修改”就地指示（出现/放弃后消失）、下载条目“复制完整路径”、
//   候选卡“复制全文”（若夹具渲染候选卡）；
// - A5 截图：欢迎页/编辑器/配图工作台在 800 与 1280 宽度的代表界面（本轮运行、源码构建）。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const {scriptedClipboard}=require('./scripted-clipboard.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const runId=Date.now().toString(36);
const evidence=path.join(repo,'.test-tmp/glm-ux-polish-20261025',runId);
fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,'.test-owner.json'),'{"purpose":"ux polish acceptance screenshots and checks"}');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction fixture required');
const report={state:'running',scope:'source Electron; real engine fixture; offline; memory clipboard adapter',checks:{},runtime:fixture.runtime,evidenceDir:evidence};
const save=()=>fs.writeFileSync(path.join(out,'ux-polish-native.json'),JSON.stringify(report,null,2));
(async()=>{
 let session;
 try{
  const copy=scriptedClipboard(repo,fixture);report.clipboardOutcomes=copy.results;session=await openNativeSession(repo,fixture.runtime,{entryPath:copy.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const _rawUntil=until;const probeUntil=async(expression,ms)=>{try{return await _rawUntil(expression,ms);}catch(error){throw Error('UNTIL['+expression.slice(0,160)+'] '+((error&&error.message)||error));}};
  
  const VK={Enter:13,Escape:27};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  await evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('ice.ui.')||k.startsWith('ice.composer.')).forEach(k=>localStorage.removeItem(k));`);

  // ---------- A5 截图：欢迎页（800 / 1280） ----------
  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
  await call('Emulation.setDeviceMetricsOverride',{width:800,height:700,deviceScaleFactor:1,mobile:false});
  await wait(200);
  let shot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,'welcome-800.png'),Buffer.from(shot.data,'base64'));
  check('welcome_no_horizontal_overflow_800',await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+2`));
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await wait(200);
  shot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,'welcome-1280.png'),Buffer.from(shot.data,'base64'));

  // 批A2（2026-10-25 R1 修复）：固定行身份（data-download-id）+ 行内按 aria-label 定位按钮。
  // 成功路径：该行按钮必须显示成功反馈（旧实现按可变文字重查会跳到另一行同名按钮）。
  // 拒绝路径：主进程内存剪贴板拒绝，真实handler返回ok:false，该次操作必须出现失败提示
  // 且同一按钮不显示成功——与 copy-button-native 的组件级旅程互补。
  const NL=String.fromCharCode(10);
  const traceRows=()=>fs.readFileSync(fixture.trace,'utf8').trim().split(NL).filter(Boolean).map(JSON.parse);
  const bindId=fixture.downloads.bind.download_id;
  const rowSel=`document.querySelector(${JSON.stringify('[data-download-id="'+bindId+'"]')})`;
  new Function('return Boolean('+rowSel+')'); // Reject malformed generated JavaScript before CDP.
  {const end=Date.now()+20000;let ok=false;
   while(Date.now()<end){if(await evaluate(`Boolean(${rowSel})`)){ok=true;break;}await wait(150);}
   if(!ok)throw Error('row wait timeout');}
  const rowBtn=`${rowSel}.querySelector('button[aria-label="复制完整路径"]')`;
  {const end=Date.now()+20000;let ok=false;
   while(Date.now()<end){if(await evaluate(`Boolean(${rowBtn})`)){ok=true;break;}await wait(150);}
   if(!ok)throw Error('button wait timeout');}
  const beforeOk=copy.rows().length;
  await evaluate(`${rowBtn}.click()`);
  const endOk=Date.now()+15000;
  while(Date.now()<endOk){
    if(copy.rows().length>beforeOk)break;
    await wait(150);
  }
  check('copy_success_pinned_row_shows_success_feedback',
    await evaluate(`${rowBtn}?.innerText.includes('路径已复制')`));
  check('copy_success_bridge_confirmed',copy.rows().length===beforeOk+1&&copy.rows().at(-1).ok===true);
  // 等待成功状态归位（1800ms 计时），再做拒绝路径。
  await wait(2200);
  copy.deny(true);const beforeDenied=copy.rows().length;
  await evaluate(`${rowBtn}.click()`);
  await until(`[...document.querySelectorAll('.ice-toast')].some(t=>t.innerText.includes('复制失败'))`);
  check('copy_denial_reached_real_handler',copy.rows().length===beforeDenied+1&&copy.rows().at(-1).ok===false);
  check('copy_denial_shows_failure_toast',true);
  check('copy_denial_no_success_on_same_button',await evaluate(`!${rowBtn}?.innerText.includes('路径已复制')`));
  copy.deny(false);report.copyFeedback={scope:'real handler; in-memory clipboard adapter; no OS clipboard'};save();

  // ---------- 编辑器：文章目录（复用证据）+ 提示词未保存指示（增量） ----------
  await evaluate(`[...document.querySelectorAll('li[data-job-id="${fixture.jobs.completed}"] button')].find(b=>b.innerText.trim()==='编辑正文')?.focus()`);
  await key('Enter');
  await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  const toc=`document.querySelector('details')&&[...document.querySelectorAll('details')].find(d=>d.innerText.includes('文章目录'))`;
  await until(`Boolean(${toc})`);
  await evaluate(`(()=>{const d=${toc}; if(d) d.open=true;})()`);
  await until(`${toc}?.querySelectorAll('button').length>=2`);
  check('toc_headings_from_real_ast',await evaluate(`${toc}.querySelector('summary').innerText.includes('章节')`));
  // 未保存指示：修改提示词前区（先保存版本/打开配图）
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存新版本')?.click()`);
  await until(`document.querySelector('.ice-editor-bar')?.innerText.includes('已保存')||document.querySelector('.ice-editor-bar')?.innerText.includes('正文已加载')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='准备配图')?.click()`);
  await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  shot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,'assets-1280.png'),Buffer.from(shot.data,'base64'));
  const promptBox=`document.querySelector('textarea[aria-label="当前图位生图提示词"]')`;
  await until(`Boolean(${promptBox})`);
  check('prompt_unsaved_indicator_absent_initially',await evaluate(`![...document.querySelectorAll('.ice-asset-card .ice-badge--warning')].some(b=>b.innerText.includes('未保存修改'))`));
  await evaluate(`${promptBox}.focus();${promptBox}.setRangeText('窗口内测试XYZ',${promptBox}.value.length,${promptBox}.value.length,'end');${promptBox}.dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(`[...document.querySelectorAll('.ice-asset-card .ice-badge--warning')].some(b=>b.innerText.includes('未保存修改'))`);
  check('prompt_unsaved_indicator_appears',true);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='放弃修改')?.click()`);
  await until(`![...document.querySelectorAll('.ice-asset-card .ice-badge--warning')].some(b=>b.innerText.includes('未保存修改'))`);
  check('discard_clears_unsaved_indicator',true);
  await key('Escape');await wait(250);
  await until(`!document.querySelector('.ice-asset-tabs')`);

  // ---------- 修改审阅（复用证据：入口与空态） ----------
  check('patch_review_entry_present',await evaluate(`Boolean([...document.querySelectorAll('details,section')].find(n=>n.innerText.includes('修改提案')||n.innerText.includes('改稿审阅')))`));

  // ---------- 下载箱：复制完整路径（增量）+ 刷新入口（复用证据） ----------
  const section=`document.querySelector('section[aria-label="下载待归档"]')`;
  await until(`Boolean(${section})`);
  check('download_refresh_entry_present',await evaluate(`${section}.innerText.includes('刷新下载列表')`));
  await until(`[...${section}.querySelectorAll('button')].some(b=>b.innerText.includes('复制完整路径'))`);
  check('download_copy_full_path_present',true);
  await call('Emulation.setDeviceMetricsOverride',{width:800,height:700,deviceScaleFactor:1,mobile:false});
  await wait(200);
  check('downloads_narrow_no_overflow',await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+2`));
  shot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,'downloads-800.png'),Buffer.from(shot.data,'base64'));
  await call('Emulation.clearDeviceMetricsOverride');

  check('no_renderer_exceptions',session.errors.length===0);
  report.state='finished';
 }catch(error){report.state='failed';report.error=String((error&&error.stack)||error);}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,evidenceDir:evidence}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
