'use strict';
// 批F1/F2（2026-10-22 用户制作流程）：新增行为的真实离线旅程。
// 复用 interaction-lists 真实引擎夹具（seed 已扩展：经真实 downloads.stage 放入两张
// 离线 PNG 到待归档箱）。覆盖：任务列表筛选/搜索/偏好持久化/建议下一步；
// 下载箱绑定确认（替换提示）、同 tick 三连点防重、写成功-刷新失败只读恢复、
// 切目标后旧图位清空、不采用文件保留；配图制作清单与 500px 视口检查。
// 键盘说明：状态筛选/搜索/按钮激活用真实 CDP 键盘；下载目标下拉为动态值列表，
// 采用受控 change（处理函数真实执行），账号域守卫由绑定前检查覆盖。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json'))||!fixture.downloads)
  throw Error('Owned interaction fixture with staged downloads required (reseed)');
const report={state:'running',scope:'source Electron; real engine + downloads.stage/bind; offline',checks:{},runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'workflow-views-native.json'),JSON.stringify(report,null,2));
const rows=()=>fs.readFileSync(fixture.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const countStarted=method=>rows().filter(r=>r.method===method&&r.phase==='started').length;
const countResolved=method=>rows().filter(r=>r.method===method&&r.phase==='resolved').length;
const waitFor=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await wait(120);}throw Error('Evidence timeout');};
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const VK={Enter:13,Escape:27,ArrowDown:40,ArrowUp:38,k:75,a:65,Backspace:8};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:keyName.length===1&&!modifiers?{text:keyName}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  const fault=control=>fs.writeFileSync(fixture.fault,JSON.stringify(control));
  const pick=(selectExpr,value)=>evaluate(`${selectExpr}.value=${JSON.stringify(value)};${selectExpr}.dispatchEvent(new Event('change',{bubbles:true}))`);

  // ---------- 批A3/A4：任务列表筛选（真实键盘）、搜索、范围说明与偏好持久化 ----------
  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
  await until(`Boolean(document.querySelector('[aria-label="任务状态筛选"]'))`);
  check('range_note_visible',await evaluate(`[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('当前范围')&&n.textContent.includes('项匹配'))`));
  check('guide_next_step_visible',await evaluate(`document.querySelector('li[data-job-id="${fixture.jobs.completed}"]').innerText.includes('建议下一步')`));
  const allCards=await evaluate(`document.querySelectorAll('li[data-job-id]').length`);
  await evaluate(`document.querySelector('[aria-label="任务状态筛选"]').focus()`);
  await key('ArrowDown'); // 全部状态 → 需要我处理（真实键盘选择）
  await until(`document.querySelector('[aria-label="任务状态筛选"]').value==='mine'`);
  await until(`document.querySelector('li[data-job-id="${fixture.jobs.completed}"]')===null`);
  check('mine_filter_hides_completed',true);
  check('mine_filter_keeps_user_pending',await evaluate(`Boolean(document.querySelector('li[data-job-id="${fixture.jobs.paused}"]'))`));
  const prefRaw=await evaluate(`window.localStorage.getItem('ice.ui.jobview.v1.${fixture.account_a}')`);
  check('view_prefs_persisted_per_account',Boolean(prefRaw)&&prefRaw.includes('"mine"'));
  await evaluate(`document.querySelector('[aria-label="任务状态筛选"]').focus()`);
  await key('ArrowUp'); // 回到全部状态
  await until(`document.querySelectorAll('li[data-job-id]').length===${allCards}`);
  const searchBox=`document.querySelector('[aria-label="搜索任务标题、栏目或期号"]')`;
  await evaluate(`${searchBox}.focus()`);
  await call('Input.insertText',{text:'已完成'});
  await until(`[...document.querySelectorAll('li[data-job-id]')].every(li=>li.innerText.includes('已完成'))&&document.querySelectorAll('li[data-job-id]').length<${allCards}`);
  check('search_filters_by_title',await evaluate(`document.querySelectorAll('li[data-job-id]').length<${allCards}`));
  await evaluate(`${searchBox}.focus()`);
  await key('a',2);await key('Backspace');
  await call('Input.insertText',{text:'不存在的任务XYZ'});
  await until(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='清除筛选条件'))`);
  check('no_match_offers_clear',true);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='清除筛选条件').click()`);
  await until(`document.querySelectorAll('li[data-job-id]').length===${allCards}`);

  // ---------- 批D：下载箱查找 ----------
  const section=`document.querySelector('section[aria-label="下载待归档"]')`;
  await until(`Boolean(${section})&&${section}.innerText.includes('download-bind.png')`);
  check('staged_downloads_listed',await evaluate(`${section}.innerText.includes('download-discard.png')`));
  await evaluate(`document.querySelector('[aria-label="搜索下载文件名"]').focus()`);
  await call('Input.insertText',{text:'discard'});
  await until(`!${section}.innerText.includes('download-bind.png')`);
  check('download_search_narrows',await evaluate(`${section}.innerText.includes('download-discard.png')`));
  await evaluate(`document.querySelector('[aria-label="搜索下载文件名"]').focus()`);
  await key('a',2);await key('Backspace');
  await until(`${section}.innerText.includes('download-bind.png')`);

  // ---------- 批D2/D3：目标确认、迟到目标清理、防重与写后读败 ----------
  const bindRow=`[...${section}.querySelectorAll('.ice-card')].find(c=>c.innerText.includes('download-bind.png'))`;
  // 迟到目标：jobs.get 延迟下先选暂停任务（无图位）再改选已完成任务——
  // 首个目标的晚到响应被忽略，最终图位选择清空且来自第二个目标的真实图位列表。
  fault({delayMs:{'jobs.get':600}});
  await pick(`${bindRow}.querySelector('[aria-label="选择文章"]')`,fixture.jobs.paused);
  await pick(`${bindRow}.querySelector('[aria-label="选择文章"]')`,fixture.jobs.completed);
  await wait(1500);
  check('late_target_clears_stale_figure',await evaluate(`${bindRow}.querySelector('[aria-label="选择图位"]').value===''&&[...${bindRow}.querySelector('[aria-label="选择图位"]').options].some(o=>o.textContent.includes('封面'))`));
  fault({});
  const coverValue=await evaluate(`[...${bindRow}.querySelector('[aria-label="选择图位"]').options].find(o=>o.textContent.includes('封面'))?.value`);
  await pick(`${bindRow}.querySelector('[aria-label="选择图位"]')`,coverValue);
  await until(`${bindRow}.innerText.includes('将绑定并采纳到')`);
  check('bind_target_summary_visible',true);
  check('replacement_warning_when_slot_valid',await evaluate(`${bindRow}.innerText.includes('已有有效图片')&&${bindRow}.innerText.includes('替换当前选用')`));
  // 同 tick 三连点 + 写成功-刷新失败分离（fail downloads.list）。
  fault({fail:['downloads.list']});
  const bindButton=`[...${bindRow}.querySelectorAll('button')].find(b=>b.innerText.trim()==='绑定并采纳')`;
  const bindBefore=countStarted('downloads.bind');
  await evaluate(`${bindButton}.click();${bindButton}.click();${bindButton}.click()`);
  await waitFor(()=>countResolved('downloads.bind')>=bindBefore+1);
  check('bind_writes_once_despite_triple_click',countStarted('downloads.bind')===bindBefore+1);
  await until(`[...document.querySelectorAll('.ice-toast')].some(t=>t.innerText.includes('下载绑定已完成，列表刷新失败'))`);
  check('bind_success_refresh_failure_separated',true);
  check('acknowledged_binding_is_locked_until_refresh',await evaluate(`(${bindButton}).disabled&&${bindRow}.querySelector('[aria-label="选择文章"]').disabled`));
  const readsBeforeRetry=countStarted('downloads.list');
  fault({});
  await evaluate(`(()=>{const b=[...document.querySelectorAll('.ice-toast')].find(t=>t.innerText.includes('下载绑定已完成'))?.querySelector('.ice-toast__action');if(!b)throw Error('Refresh retry missing');b.click();})()`);
  await waitFor(()=>countStarted('downloads.list')>readsBeforeRetry);
  await until(`${section}.innerText.includes('#fig${coverValue}')`);
  check('read_only_refresh_recovers_bound_state',countStarted('downloads.bind')===bindBefore+1);
  // 不采用：逻辑状态 + 磁盘文件保留。
  const discardRow=`[...${section}.querySelectorAll('.ice-card')].find(c=>c.innerText.includes('download-discard.png'))`;
  await until(`Boolean(${discardRow})`);
  await evaluate(`[...${discardRow}.querySelectorAll('button')].find(b=>b.innerText.trim()==='不采用').click()`);
  await waitFor(()=>countStarted('downloads.bind')>=bindBefore+2);
  await until(`${section}.innerText.includes('已判定不采用')`);
  check('discard_keeps_file_on_disk',fs.existsSync(fixture.downloads.discard.file_path));

  // ---------- 批C1/C2：配图计划总览 + 制作清单 + F3 视口 ----------
  await evaluate(`[...document.querySelectorAll('li[data-job-id="${fixture.jobs.completed}"] button')].find(b=>b.innerText.trim()==='编辑正文')?.focus()`);
  await key('Enter');
  await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存新版本')?.click()`);
  await until(`document.querySelector('.ice-editor-bar')?.innerText.includes('已保存')||document.querySelector('.ice-editor-bar')?.innerText.includes('正文已加载')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='准备配图')?.click()`);
  await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  const overview=`document.querySelector('details[aria-label="配图计划总览"]')`;
  await until(`Boolean(${overview})`);
  check('asset_overview_lists_slots',await evaluate(`${overview}.querySelectorAll('li').length>=3`));
  await evaluate(`${overview}.open=true`);
  check('next_pending_figure_button',await evaluate(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.includes('下一个待处理图位')))||${overview}.innerText.includes('全部图位均已有有效图片')`));
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='制作清单…')?.click()`);
  await until(`Boolean([...document.querySelectorAll('[role="dialog"]')].find(d=>d.innerText.includes('配图制作清单')))`);
  const checklist=`[...document.querySelectorAll('[role="dialog"]')].find(d=>d.innerText.includes('配图制作清单'))`;
  check('checklist_covers_figures_and_honest_references',await evaluate(`${checklist}.innerText.includes('## 图1')&&${checklist}.innerText.includes('## 图2')&&${checklist}.innerText.includes('本次未读取')&&${checklist}.innerText.includes('不会调用模型')`));
  check('checklist_copy_button_present',await evaluate(`Boolean([...${checklist}.querySelectorAll('button')].find(b=>b.innerText.includes('复制制作清单')))`));
  await call('Emulation.setDeviceMetricsOverride',{width:500,height:760,deviceScaleFactor:1,mobile:false});
  await wait(150);
  check('checklist_fits_narrow_viewport',await evaluate(`${checklist}.getBoundingClientRect().left>=0&&${checklist}.getBoundingClientRect().right<=window.innerWidth+2&&document.documentElement.scrollWidth<=window.innerWidth+2`));
  await call('Emulation.clearDeviceMetricsOverride');
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='关闭清单')?.click()`);
  await until(`![...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes('配图制作清单'))`);
  await key('Escape');await wait(200);
  await until(`!document.querySelector('.ice-asset-tabs')`);

  check('no_renderer_exceptions',session.errors.length===0);
  fault({});
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
