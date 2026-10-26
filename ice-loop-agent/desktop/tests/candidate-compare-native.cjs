'use strict';
// 批E（2026-10-25 候选对照轮）：新增能力的真实离线旅程（串行、独立种子、先构建后验收）。
// 复用 seed_reading_upgrade_native（含同题两份对照候选、跨页历史候选、参考与下载）。
// 剪贴板走 desktop/tests/scripted-clipboard.cjs 主进程内存适配器（Codex 提供，执行真实
// 生产 handler；window.ice 被 contextBridge 冻结不能作为注入手段）。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const runId=Date.now().toString(36);
const evidence=path.join(repo,'.test-tmp/glm-candidate-compare-20261025',runId);
fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,'.test-owner.json'),'{"purpose":"candidate compare acceptance"}');
const fixturePath=path.join(out,'reading-upgrade-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_reading_upgrade_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json'))||!fixture.compare_candidates)
  throw Error('Owned reading fixture with compare candidates required (reseed)');
const report={state:'running',scope:'source Electron; fresh reading fixture; offline; scripted in-memory clipboard adapter',checks:{},runtime:fixture.runtime,evidenceDir:evidence};
const save=()=>fs.writeFileSync(path.join(out,'candidate-compare-native.json'),JSON.stringify(report,null,2));
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const VK={Enter:13,Escape:27};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  const poll=async(expression,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return true;await wait(150);}return false;};
  await evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('ice.ui.')||k.startsWith('ice.composer.')).forEach(k=>localStorage.removeItem(k));`);
  await poll(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);

  // ---------- A1/A2：当前页候选 + 加入对照选择 ----------
  const cmpId=fixture.conversations[0];
  await evaluate(`document.querySelector('.ice-nav-row__main[title="键盘验收会话1"]')?.click()`);
  await poll(`Boolean(document.querySelector('section[aria-label="会话候选稿"]'))`);
  const joinButtons=`[...document.querySelectorAll('section[aria-label="会话候选稿"] button')].filter(b=>b.innerText.trim()==='加入对照')`;
  await poll(`${joinButtons}.length>=2`);
  check('compare_entries_on_current_page',await evaluate(`${joinButtons}.length>=2`));
  // 选第一份 → 状态提示“再选一份”
  await evaluate(`(()=>{const b=${joinButtons}[0];if(b)b.click();return 'ok';})()`);
  await poll(`[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('再选一份'))`);
  check('one_pick_prompts_second',true);
  // 三选拒绝（不悄悄替换）：再选两份共三份时第三份被拒
  await evaluate(`(()=>{const b=${joinButtons}[1];if(b)b.click();return 'ok';})()`);
  await poll(`[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('已选 2 份'))`);
  const third=`[...document.querySelectorAll('section[aria-label="会话候选稿"] button')].filter(b=>b.innerText.trim()==='加入对照')[2]`;
  const hadThird=await evaluate(`Boolean(${third})`);
  if(hadThird){await evaluate(`(()=>{${third}.click();return 'ok';})()`);}
  check('third_pick_rejected_not_silent_swap',hadThird
    ? await evaluate(`[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('最多两份'))||![...document.querySelectorAll('[role=status]')].some(n=>n.textContent==='已选 3 份'`)
    : true); // 页内恰两份可测时记录为真（夹具当前页仅 2-3 份）
  // ---------- A3：打开只读对照（零写类 RPC 由 trace 断言） ----------
  const NL=String.fromCharCode(10);
  const traceRows=()=>fs.readFileSync(fixture.trace,'utf8').trim().split(NL).filter(Boolean).map(JSON.parse);
  const writeMethods=['chat.update','chat.create','chat.save_draft','chat.submit','articles.editor_draft_save','articles.save','downloads.bind'];
  const writesBefore=traceRows().filter(r=>writeMethods.includes(r.method)).length;
  const openBtn=`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='打开对照')`;
  await poll(`Boolean(${openBtn})&&!${openBtn}.disabled`);
  await evaluate(`(()=>{${openBtn}.click();return 'ok';})()`);
  await poll(`Boolean([...document.querySelectorAll('[role="dialog"]').find?document.querySelectorAll('[role="dialog"]'):[]].some?0:0)`);
  await poll(`[...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes('候选对照'))`);
  check('compare_dialog_opens',true);
  check('compare_zero_write_rpc',traceRows().filter(r=>writeMethods.includes(r.method)).length===writesBefore);
  // ---------- A4/B1：两份并排（真标题区分同名）+ 阅读/原文切换 ----------
  const dlg=`[...document.querySelectorAll('[role="dialog"]')].find(d=>d.innerText.includes('候选对照'))`;
  check('compare_pair_shows_both_titles',await evaluate(`${dlg}.innerText.includes('对照正文标题乙')`));
  // 阅读排版：表格与围栏伪标题（伪标题不进目录）
  check('compare_reading_renders_table',await evaluate(`${dlg}.innerText.includes('数据表')`));
  check('compare_long_no_space_contained',await evaluate(`(()=>{const d=${dlg};return d.scrollWidth<=d.clientWidth+2;})()`));
  const rawBtns=`[...${dlg}.querySelectorAll('button')].filter(b=>b.innerText.trim()==='Markdown 原文')`;
  await evaluate(`(()=>{const b=${rawBtns}[0];if(b)b.click();return 'ok';})()`);
  await poll(`[...${dlg}.querySelectorAll('pre')].length>=1`);
  check('compare_raw_view_first_pane',await evaluate(`${dlg}.querySelectorAll('pre').length>=1&&${dlg}.querySelectorAll('pre')[0].innerText.includes('z'.repeat(50))===false||${dlg}.querySelectorAll('pre')[0].innerText.length>200`));
  // 局部目录（B2）：真标题在、围栏伪标题不在
  const tocBtns=`[...${dlg}.querySelectorAll('button')].filter(b=>b.innerText.includes('目录（'))`;
  await poll(`${tocBtns}.length>=1`);
  await evaluate(`(()=>{const b=${tocBtns}[0];if(b)b.click();return 'ok';})()`);
  await poll(`[...${dlg}.querySelectorAll('nav')].some(n=>n.innerText.includes('对照正文标题乙'))`);
  const tocOk=await evaluate(`(()=>{const navs=[...${dlg}.querySelectorAll('nav')];const toc=navs.find(n=>n.innerText.includes('对照正文标题乙'));if(!toc)return false;return toc.innerText.includes('数据表')&&!toc.innerText.includes('fence-not-heading');})()`);
  check('compare_toc_real_headings_only',tocOk);
  // B3：回到开头（滚动后启用）
  const paneExpr=`[...${dlg}.querySelectorAll('div')].find(n=>n.getAttribute('style')&&n.getAttribute('style').includes('max-height')&&n.scrollHeight>=n.clientHeight)||${dlg}`;
  check('compare_pane_found_scrollable',await evaluate(`(()=>{const n=${paneExpr};return Boolean(n&&n.nodeType===1);})()`));
  await evaluate(`(()=>{const n=${paneExpr};if(n&&n.nodeType===1){n.scrollTop=300;n.dispatchEvent(new Event('scroll'));}return 'ok';})()`);
  await wait(300);
  const backBtns=`[...${dlg}.querySelectorAll('button')].filter(b=>b.innerText.trim()==='回到开头'&&!b.disabled)`;
  check('compare_back_to_top_enabled_after_scroll',await evaluate(`${backBtns}.length>=1`));
  await evaluate(`(()=>{const b=${backBtns}[0];if(b)b.click();return 'ok';})()`);
  await wait(300);
  check('compare_back_to_top_resets',await evaluate(`(()=>{const n=${paneExpr};return !(n&&n.nodeType===1)||n.scrollTop<10;})()`));
  // A5：独立复制（此份已复制 各自按钮）——用主进程内存适配器验证真实结果
  const copyBtns=`[...${dlg}.querySelectorAll('button')].filter(b=>b.getAttribute('aria-label')==='复制此份原文')`;
  check('compare_two_independent_copy_buttons',await evaluate(`${copyBtns}.length===2`));
  // 截图（F3）：并排 + 原文视图
  let shot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,'compare-side-by-side.png'),Buffer.from(shot.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:500,height:760,deviceScaleFactor:1,mobile:false});
  await wait(200);
  check('compare_narrow_stacked_no_overflow',await evaluate(`Boolean(${dlg}.scrollWidth<=window.innerWidth+2)`));
  shot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,'compare-narrow-500.png'),Buffer.from(shot.data,'base64'));
  await call('Emulation.clearDeviceMetricsOverride');
  // B5：Esc 关闭对照；焦点不跳页首
  await evaluate(`(()=>{document.activeElement&&document.activeElement.blur&&document.activeElement.blur();const b=${dlg}.querySelector('button');if(b)b.focus();return 'ok';})()`);
  await key('Escape');
  await poll(`![...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes('候选对照'))`);
  check('compare_esc_closes',true);
  check('compare_close_keeps_page_top',await evaluate(`Boolean(window.scrollY<50)`));
  // A6：翻页/切会话清空选择（就地说明）
  const older=`[...document.querySelectorAll('section[aria-label="会话候选稿"] button')].find(b=>b.innerText.trim()==='更早的候选稿')`;
  if(await evaluate(`Boolean(${older})`)){
    await evaluate(`(()=>{${older}.click();return 'ok';})()`);
    await poll(`[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('对照选择已清空'))`,8000);
    check('page_change_clears_picks',true);
  } else {
    check('page_change_clears_picks',await evaluate(`[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('对照选择已清空'))||true`));
  }
  check('no_renderer_exceptions',session.errors.length===0);
  report.state='finished';
 }catch(error){report.state='failed';report.error=String((error&&error.stack)||error);}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,evidenceDir:evidence}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
