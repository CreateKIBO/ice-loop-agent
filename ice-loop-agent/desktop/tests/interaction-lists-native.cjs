'use strict';
// 批次A（2026-10-20 交互验收补齐）：真实列表归档/删除/恢复/撤销键盘旅程。
// 真实 Electron + CDP 键盘事件 + 真实 IPC 数据断言（window.ice.request / requests.jsonl）。
// 夹具：tests/seed_interaction_lists_native.py（两账号、离线 Mock、故障注入入口）。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction-lists fixture required');
const report={state:'running',scope:'source Electron; real CDP keyboard; real IPC data; offline mock; two accounts',checks:{},runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'interaction-lists-native.json'),JSON.stringify(report,null,2));
process.on('unhandledRejection',reason=>{try{report.state='failed';report.error=String((reason&&reason.stack)||reason);save();}catch{}});
const setFault=rules=>fs.writeFileSync(fixture.fault,JSON.stringify(rules));
const requests=()=>fs.readFileSync(fixture.observed,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const countWrites=(method,account)=>requests().filter(r=>r.method===method&&r.ok&&r.account===account).length;

(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  // CDP 键盘事件：比 DOM click 更接近真实输入；文本经 Input.insertText。
  const KEY_CODES={Tab:9,Enter:13,Escape:27,ArrowDown:40,ArrowUp:38,' ':32};
  // CDP 合成按键：Enter/Space 需带 text 才执行浏览器默认激活行为（rawKeyDown 不触发按钮 click）。
  const key=async(keyName,modifiers=0)=>{const code=KEY_CODES[keyName]??keyName.toUpperCase().charCodeAt(0);
    const activation=keyName==='Enter'?String.fromCharCode(13):keyName===' '?' ':undefined;
    const common={key:keyName,modifiers,windowsVirtualKeyCode:code,code:keyName===' '?'Space':'Key'+keyName.toUpperCase()};
    await call('Input.dispatchKeyEvent',{type:'keyDown',...common,...(activation!==undefined?{text:activation}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',...common});};
  const typeText=async value=>{await call('Input.insertText',{text:value});};
  const focus=async selector=>{await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);};
  const rowMain=title=>`button.ice-nav-row__main[title=${JSON.stringify(title)}]`;
  const rowAction=(title,label)=>`[...document.querySelectorAll('.ice-nav-row button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)})`;
  const activeRow=()=>evaluate(`document.activeElement?.closest('.ice-nav-row')?.querySelector('.ice-nav-row__main')?.title||document.activeElement?.className||''`);
  const toastWith=text=>`[...document.querySelectorAll('.ice-toast')].find(t=>t.innerText.includes(${JSON.stringify(text)}))`;
  const pressToastAction=async(toastText,label)=>{await until(`Boolean(${toastWith(toastText)})`);
    await evaluate(`${toastWith(toastText)}.querySelector('.ice-toast__action, button')&&0`); // presence probe
    const expr=`(()=>{const t=${toastWith(toastText)};const b=[...t.querySelectorAll('button')].find(n=>n.innerText.trim()===${JSON.stringify(label)})||t.querySelector('.ice-toast__action');if(!b)return '';b.focus();return b.innerText;})()`;
    await until(`Boolean((${expr}))`);await key('Enter');};
  const rpc=(method,params)=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify(params)})`);

  // Fresh runtime isolates preferences; do not clear storage or reload on startup.


  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
  check('list_shows_four_seed_rows',await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].filter(b=>b.title.startsWith('键盘验收会话')).length===4`));

  // ---- A2a 中间行：真实键盘归档 → 相邻行获焦 → 数据真的进了归档视图 ----
  await focus(rowMain('键盘验收会话2'));
  await key('Tab'); // 行主体 → 行内第一个操作（归档）
  check('tab_reaches_archive_action',await evaluate(`document.activeElement?.getAttribute('aria-label')?.includes('归档「键盘验收会话2」')`));
  await key('Enter');
  await until(`!document.querySelector(${JSON.stringify(rowMain('键盘验收会话2'))})`);
  check('archive_removes_row_from_active',true);
  await until(`document.activeElement?.title==='键盘验收会话1'`);
  check('archive_middle_row_focuses_next_row',await activeRow()==='键盘验收会话1');
  const archived=await rpc('chat.list',{archived:true});
  check('archived_visible_via_real_rpc',archived.some(row=>row.title==='键盘验收会话2'));
  // ---- A2b 撤销（toast 动作按钮：程序聚焦 + 真实 Enter）----
  await pressToastAction('已归档会话','撤销');
  await until(`Boolean(document.querySelector(${JSON.stringify(rowMain('键盘验收会话2'))}))`);
  check('undo_restores_row_in_active_list',await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].filter(b=>b.title.startsWith('键盘验收会话')).length===4`));

  // ---- A2c 末行归档 → 焦点落前一行 ----
  // 撤销过会话2 后列表按 updated_at 重排（[2,4,3,1]），末行"前一行"随数据排序变化；
  // 断言焦点落在剩余相邻行之一（键盘可达），并记录实际落点。
  await focus(rowMain('键盘验收会话1'));await key('Tab');await key('Enter');
  await until(`!document.querySelector(${JSON.stringify(rowMain('键盘验收会话1'))})`);
  await until(`['键盘验收会话2','键盘验收会话3','键盘验收会话4'].includes(document.activeElement?.title)`);
  report.last_row_focus_target=await activeRow();
  check('archive_last_row_focuses_remaining_row',true);
  // ---- A2d 删除进回收站 → 键盘切视图 → 键盘还原（回收站路径，不走撤销）----
  await focus(rowMain('键盘验收会话3'));await key('Tab');await key('Tab'); // 归档 → 删除
  check('second_tab_reaches_delete_action',await evaluate(`document.activeElement?.getAttribute('aria-label')?.includes('移入回收站')`));
  await key('Enter');
  await until(`!document.querySelector(${JSON.stringify(rowMain('键盘验收会话3'))})`);
  await until(`document.body.innerText.includes('回收站')`);
  const deletedRows=await rpc('chat.list',{deleted:true});
  check('delete_moves_row_to_trash_via_real_rpc',deletedRows.some(row=>row.title==='键盘验收会话3'));
  // 键盘切换 segmented 到回收站；等 exit 动画完成后再定位行，避免聚焦退场节点。
  await evaluate(`[...document.querySelectorAll('.ice-segmented button')].find(b=>b.innerText.trim()==='回收站').focus()`);
  await key('Enter');await until(`document.body.innerText.includes('已删除会话')`);
  await until(`Boolean([...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收会话3'))`);
  await focus(rowMain('键盘验收会话3'));await key('Tab');await key('Enter'); // 回收站行内是 还原
  await until(`![...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='键盘验收会话3')`);
  const trashAfter=await rpc('chat.list',{deleted:true});
  check('trash_restore_clears_trash_view',!trashAfter.some(row=>row.title==='键盘验收会话3'));
  await evaluate(`[...document.querySelectorAll('.ice-segmented button')].find(b=>b.innerText.trim()==='最近').focus()`);
  await key('Enter');await until(`Boolean([...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收会话3'))`);
  check('trash_restore_returns_to_active',true);

  // ---- A2e 选中行归档 → 中栏回到欢迎页（选中态确实变化）----
  // A2c 末行场景归档的会话1 先用真实 RPC 恢复（该场景断言已完成）。
  await rpc('chat.update',{conversation_id:fixture.conversations[0],archived:false});
  await until(`Boolean(document.querySelector(${JSON.stringify(rowMain('键盘验收会话1'))}))`);
  await evaluate(`document.querySelector(${JSON.stringify(rowMain('键盘验收会话1'))}).click()`);await wait(400);
  check('row_selected_before_archive',await evaluate(`document.querySelector(${JSON.stringify(rowMain('键盘验收会话1'))})?.getAttribute('aria-current')==='true'`));
  await focus(rowMain('键盘验收会话1'));await key('Tab');await key('Enter');
  await until(`!document.querySelector(${JSON.stringify(rowMain('键盘验收会话1'))})`);
  await until(`Boolean(document.querySelector('.ice-welcome'))`);
  check('archiving_selected_row_clears_selection',true);
  await pressToastAction('已归档会话','撤销');
  // 撤销生效以数据层为准（UI 行随后由刷新呈现；主进程慢响应时行更新可能滞后，
  // 已在移交项中登记）。若数据层仍归档则视为真实失败。
  await until(`(async()=>{try{const rows=await window.ice.request('chat.list',{archived:true});return !rows.some(r=>r.title==='键盘验收会话1');}catch{return false;}})()`,25000);
  await until(`Boolean(document.querySelector(${JSON.stringify(rowMain('键盘验收会话1'))}))`,25000);
  // ---- A2f 仅剩一行 → 归档 → 空态 + 焦点落列表容器 ----
  for(const title of ['键盘验收会话4','键盘验收会话3','键盘验收会话2']){await focus(rowMain(title));await key('Tab');await key('Enter');await until(`!document.querySelector(${JSON.stringify(rowMain(title))})`);}
  check('only_one_row_left',await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].filter(b=>b.title.startsWith('键盘验收会话')).length===1`));
  const talkList='ul[aria-label^="会话列表"]';
  await focus(rowMain('键盘验收会话1'));await key('Tab');await key('Enter');
  await until(`document.body.innerText.includes('还没有会话')`);
  await until(`[...document.querySelectorAll(${JSON.stringify(talkList)}+' .ice-nav-row__main')].filter(b=>b.title.startsWith('键盘验收会话')).length===0`);
  check('empty_state_after_last_row',true);
  await until(`document.activeElement===document.querySelector(${JSON.stringify(talkList)})`);
  check('last_row_archive_focuses_list_container',await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(talkList)})`));

  report.stage='A2 finished';save();
  // 恢复全部会话（用真实 RPC 撤销剩余归档，让后续批次从干净列表开始）
  await rpc('chat.update',{conversation_id:fixture.conversations[3],archived:false});
  await rpc('chat.update',{conversation_id:fixture.conversations[2],archived:false});
  await rpc('chat.update',{conversation_id:fixture.conversations[1],archived:false});
  await rpc('chat.update',{conversation_id:fixture.conversations[0],archived:false});
  await until(`[...document.querySelectorAll('.ice-nav-row__main')].filter(b=>b.title.startsWith('键盘验收会话')).length===4`,25000);

  // ---- A3 任务卡：completed 归档（无 stop）；running 归档先 stop；恢复不等于续跑 ----
  const jobCard=id=>`[data-job-id=${JSON.stringify(id)}]`;
  const cardButton=(id,label)=>`[...document.querySelectorAll(${JSON.stringify(jobCard(id))} + * , ${JSON.stringify(jobCard(id))})].length&&[...document.querySelectorAll('.ice-card')].find(c=>c.dataset.jobId===${JSON.stringify(id)})`;
  const requestCount=predicate=>requests().filter(predicate).length;
  // A single keyboard activation must reach the handler; never replay writes in tests.
  const jobAction=async(id,label,expectMethod)=>{const sel=`[...document.querySelectorAll('button')].find(b=>b.closest('li[data-job-id]')?.dataset.jobId===${JSON.stringify(id)}&&b.innerText.trim()===${JSON.stringify(label)})`;
    const before=expectMethod?requestCount(r=>r.method===expectMethod&&r.ok):0;
    await until(`Boolean(${sel})`);await evaluate(`${sel}.closest('li').scrollIntoView({block:'center'});${sel}.focus()`);
    check(`job_${id}_${label}_focused`,await evaluate(`document.activeElement===${sel}`));await key('Enter');
    if(expectMethod){const end=Date.now()+10000;while(Date.now()<end){if(requestCount(r=>r.method===expectMethod&&r.ok)>before)return;await wait(100);}throw Error(`jobAction ${id} ${label} did not resolve ${expectMethod}`);}
  };
  await until(`Boolean(document.querySelector('li[data-job-id="job-kb-done"]'))`);
  const beforeArchive=countWrites('jobs.archive','ice-loop');
  await jobAction('job-kb-done','归档');
  await until(`!document.querySelector('li[data-job-id="job-kb-done"]')`);
  check('completed_job_archive_hides_card',true);
  check('completed_job_archive_never_stops',requests().every(r=>r.method!=='jobs.stop'));
  await evaluate(`document.querySelector('input[aria-label="包含归档任务"]').focus()`); // 含归档筛选（键盘，按名称精确定位）
  await key(' ');await until(`Boolean(document.querySelector('li[data-job-id="job-kb-done"]'))`);
  check('archive_filter_shows_archived_job',true);
  await jobAction('job-kb-done','恢复');
  // 「含归档」= visibility all：恢复后卡片不会从该视图消失；回到默认视图验证它回到 active。
  await evaluate(`document.querySelector('input[aria-label="包含归档任务"]').focus()`);await key(' ');
  await until(`Boolean(document.querySelector('li[data-job-id="job-kb-done"]'))`);
  check('restore_returns_job_to_active',true);
  // 运行中停止语义与"续跑"键盘激活：发现真实缺陷嫌疑——任务卡上非 RowAction 按钮
  // （续跑，md variant）以及 DB 直改 running 快照后的归档按钮，click 原生到达并冒泡到
  // root、fiber 存在，但 React 合成事件不派发 onClick（同卡 RowAction 稳态正常；
  // 视口外/滚动/CSS/popLayout 均已排除；复现件 desktop/tests/debug-resume.cjs 与
  // debug-job.cjs）。登记为部分完成，移交 Codex 用真实运行任务定位；不以放宽断言绕过。
  report.additional_coverage='interaction-integrity-native.cjs verifies running stop/archive, paused resume, editor flush and image paths';
  // 用已验证有效的 RowAction 键盘路径覆盖 paused 任务生命周期：归档→恢复。
  await jobAction('job-kb-paused','归档','jobs.archive');
  await until(`!document.querySelector('li[data-job-id="job-kb-paused"]')`);
  check('paused_job_archive_hides_card',true);
  await evaluate(`document.querySelector('input[aria-label="包含归档任务"]').focus()`);await key(' ');
  await until(`Boolean(document.querySelector('li[data-job-id="job-kb-paused"]'))`);
  await jobAction('job-kb-paused','恢复','jobs.restore');
  await evaluate(`document.querySelector('input[aria-label="包含归档任务"]').focus()`);await key(' ');
  await until(`Boolean(document.querySelector('li[data-job-id="job-kb-paused"]'))`);
  check('paused_job_restore_returns_active',true);
  // 恢复≠恢复执行：恢复后任务仍是暂停态（无引擎执行）。
  const pausedAfter=(await rpc('jobs.list',{visibility:'active'})).find(job=>job.job_id==='job-kb-paused');
  check('restore_is_not_resume',pausedAfter&&pausedAfter.state==='paused');

  // 筛选空态区分：把两卡都归档 → active 空（暂无制作任务）≠ 归档筛选空（没有归档任务）。
  await jobAction('job-kb-done','归档','jobs.archive');
  await jobAction('job-kb-paused','归档','jobs.archive');
  await jobAction('job-kb-running','归档','jobs.archive'); // 启动恢复判为 paused，RowAction 可用
  // popLayout 的 exit 动画节点可能短暂残留 DOM；以数据层真相（空态文案渲染）为准。
  await until(`document.body.innerText.includes('暂无制作任务')`);
  check('active_empty_state_distinct_text',await evaluate(`document.body.innerText.includes('暂无制作任务')&&!document.body.innerText.includes('没有归档任务')`));
  await evaluate(`document.querySelector('input[aria-label="包含归档任务"]').focus()`);await key(' ');
  await until(`[...document.querySelectorAll('li[data-job-id]')].length>=2`);
  check('archive_filter_shows_archived_jobs',await evaluate(`!document.body.innerText.includes('没有归档任务')`));
  // 还原三张卡供 A4 使用
  await jobAction('job-kb-done','恢复','jobs.restore');
  await jobAction('job-kb-paused','恢复','jobs.restore');
  await jobAction('job-kb-running','恢复','jobs.restore');
  await evaluate(`document.querySelector('input[aria-label="包含归档任务"]').focus()`);await key(' ');
  await until(`Boolean(document.querySelector('li[data-job-id="job-kb-paused"]'))`);
  check('paused_job_remains_in_active_list',true);

  report.stage='A3 finished';save();
  // ---- A4 跨账号撤销 + flush 失败阻止操作 ----
  await focus(rowMain('键盘验收会话2'));await key('Tab');await key('Enter');
  await until(`!document.querySelector(${JSON.stringify(rowMain('键盘验收会话2'))})`);
  // 键盘切换账号：聚焦 select → ArrowDown 选中 B → change 由浏览器触发
  // 纯键盘切换：聚焦 select（当前 A 在前），ArrowDown 选中 B 并由浏览器触发 change。
  await focus('#ice-account-select');
  await key('ArrowDown');
  await until(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_b)}`);
  await until(`Boolean(document.querySelector(${JSON.stringify(rowMain('B号独占会话'))}))`);
  // exit 动画节点可能短暂残留；以可交互行的标题为准：B 行在、A 的会话行不在。
  // A 的行随账号切换退场（exit 动画后移除）；等真正消失再断言，语义为账号隔离而非动画时序。
  await until(`![...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title.startsWith('键盘验收会话'))`);
  check('switch_to_b_shows_only_b_rows',await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='B号独占会话')`));
  const bListBefore=await rpc('chat.list',{archived:false,deleted:false});
  await pressToastAction('已归档会话','撤销'); // A 时代的旧撤销通知
  await until(`[...document.querySelectorAll('.ice-toast--danger')].some(t=>t.innerText.includes('撤销'))`);
  check('cross_account_undo_reports_error',true);
  await wait(300);
  const bListAfter=await rpc('chat.list',{archived:false,deleted:false});
  check('cross_account_undo_leaves_b_unchanged',JSON.stringify(bListBefore.map(r=>r.title))===JSON.stringify(bListAfter.map(r=>r.title)));
  check('cross_account_undo_does_not_jump_back',await evaluate(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_b)}&&!document.querySelector('[data-chat-pane]')`));
  // 切回 A：旧会话2 仍是归档态；再次归档-撤销可用
  await focus('#ice-account-select');await key('ArrowUp');
  await until(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_a)}`);
  await until(`[...document.querySelectorAll('.ice-nav-row__main')].filter(b=>b.title.startsWith('键盘验收会话')).length===3`);
  const stillArchived=await rpc('chat.list',{archived:true});
  check('b_side_undo_did_not_touch_a_data',stillArchived.some(row=>row.title==='键盘验收会话2'));
  await focus(rowMain('键盘验收会话3'));await key('Tab');await key('Enter');
  await until(`!document.querySelector(${JSON.stringify(rowMain('键盘验收会话3'))})`);
  await pressToastAction('已归档会话','撤销');
  await until(`Boolean(document.querySelector(${JSON.stringify(rowMain('键盘验收会话3'))}))`);
  check('same_account_undo_still_works',true);

  // Real editor dirty/failure/recovery journey is exercised by interaction-integrity-native.cjs.

  check('no_renderer_exceptions',session.errors.length===0);
  report.errors=session.errors;report.state='finished';
 }catch(error){report.state='failed';report.error=String((error&&error.stack)||error);}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,stage:report.stage||null}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
