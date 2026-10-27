'use strict';
const fs = require('node:fs'), path = require('node:path');
const { startTrace, expectRemoval, finishAction, stopTrace, auditRemovals } = require('./lifecycle-trace.cjs');
// ICE_LIFECYCLE_SCOPE=round3：后台任务写入 / 图位计划实际变化的时序证据。
// 写入全部经真实服务 RPC（downloads.stage、downloads.bind、jobs.stop）驱动隔离夹具的
// 真实持久化链（下载归档→资源导入→候选→slot 采纳；任务状态写入）。
// 边界：未启用生产消费者线程（夹具无 queued production 任务，构造任务链超出本轮有界范围）；
// 慢 jobs.get 的延迟施加在测试桥交付层（服务处理不被阻塞），沿用 round2 记录口径。
module.exports = async function round3(ctx) {
  const { e, call, ui, btn, click, check, until, wait, rpc, count, requests, faults, fixture, report } = ctx;
  const dialog = title => `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent===${JSON.stringify(title)})`;
  const workspace = dialog('文章配图工作台');
  const inButton = (root, text) => `[...(${root}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&!n.disabled)`;
  const detailParams = { account_id: fixture.account_a, job_id: fixture.jobs.completed };
  const planSummary = detail => ({ job: detail.job?.job_id, state: detail.job?.state, account: detail.article?.spec?.account_id,
    body_hash: detail.body_hash, slots: (detail.slots || []).map(s => ({ slot_id: s.slot_id, figure_no: s.figure_no, kind: s.kind,
      valid: Boolean(s.valid), candidates: (s.candidates || []).length })) });
  const audit = async label => {
    const trace = await stopTrace(e);
    trace.removalAudit = auditRemovals(trace, ['tabs', 'dialog', 'editor']);
    (report.d6 ??= []).push(trace);
    check(label + '_only_exact_expected_removals', !trace.removalAudit.unexpected.length && !trace.removalAudit.missingOrRepeated.length);
    return trace;
  };
  const switchAccount = async account => {
    await ui(`!document.querySelector('#ice-account-select').disabled`);
    await e(`(()=>{const n=document.querySelector('#ice-account-select');n.value=${JSON.stringify(account)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await ui(`document.querySelector('#ice-account-select').value===${JSON.stringify(account)}&&!document.querySelector('#ice-account-select').disabled&&!document.querySelector('.ice-editor')&&!document.querySelector('[role="dialog"]')`);
  };
  report.r3 = { boundary: 'harness-channel real-service writes (downloads.stage/bind, jobs.stop); consumer thread not enabled; slow reply delay applied at bridge delivery', writes: [] };
  // B6 紧凑回归：真实后台读败→恢复，阅读器节点保留。
  await click(`document.querySelector('button[title="键盘验收会话1"]')`);
  const latest = 'candidate-expand-reading-recent-5';
  await click(`document.getElementById('${latest}')`); await click(btn('Markdown 原文'));
  await e(`void(window.__b6=document.getElementById('${latest}'))`);
  const failureStart = requests.length; faults.set('chat.get', { fail: true });
  await until(() => requests.slice(failureStart).some(r => r.method === 'chat.get' && r.failed), 'r3 B6 failed background read');
  await ui(`document.body.textContent.includes('会话刷新失败')`);
  check('r3_b6_failed_poll_preserves_reader', await e(`window.__b6===document.getElementById('${latest}')&&window.__b6.getAttribute('aria-expanded')==='true'&&Boolean(document.querySelector('.ice-candidate-reader pre'))`));
  faults.delete('chat.get');
  const recovered = count('chat.get'); await until(() => count('chat.get') > recovered, 'r3 B6 recovery');
  check('r3_b6_recovery_preserves_reader', await e(`window.__b6===document.getElementById('${latest}')&&window.__b6.getAttribute('aria-expanded')==='true'`));
  // 真实链打开：复位→真实 Enter 打开编辑器→实际改文→保存新版本→等待解锁→准备配图。
  await e(`document.querySelector('[aria-label="任务列表紧凑视图"]').click()`);
  await ui(`document.querySelector('[aria-label="任务列表紧凑视图"]')?.checked===true`);
  await click(btn('恢复默认视图'));
  const editBtn = `[...document.querySelectorAll('[data-job-id="${fixture.jobs.completed}"] button')].find(n=>n.textContent.trim()==='编辑正文'&&!n.disabled)`;
  await ui(`Boolean(${editBtn})`); await e(`(${editBtn}).focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await ui(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await e(`document.querySelector('.ice-editor').focus()`); await call('Input.insertText', { text: '第3轮后台写入验收 ' });
  const saves = count('articles.save'); await click(btn('保存新版本'));
  await until(() => count('articles.save') > saves, 'r3 explicit save');
  await ui(`Boolean(${btn('保存新版本')})`);
  await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  await e(`void(window.__r3Tabs=document.querySelector('.ice-asset-tabs'))`);
  const pollBase = count('jobs.list');
  const before = planSummary(await rpc('jobs.get', detailParams));
  report.r3.planBefore = before;
  check('r3_workspace_initial_identity', before.job === fixture.jobs.completed && before.account === fixture.account_a && Boolean(before.body_hash));
  check('r3_plan_before_one_of_four', before.slots.length === 4 && before.slots.filter(s => s.valid).length === 1
    && await e(`document.body.textContent.includes('1/4 个图位已有有效图片')`));
  // 序列一：工作台打开期间的真实图位计划写入（downloads.bind 图2）→ 手动刷新可读。
  const trace1Started = Date.now();
  await startTrace(e, 'r3-plan-write-while-open');
  const bind1Index = requests.length;
  await rpc('downloads.bind', { account_id: fixture.account_a, job_id: fixture.jobs.completed, figure_no: 2, slot_label: '图2', download_id: fixture.downloads.bind.download_id });
  const w1 = requests[bind1Index];
  check('r3_bind_committed_via_real_service', Boolean(w1 && w1.finished && !w1.failed));
  const refresh1 = requests.length; await click(inButton(workspace, '刷新配图'));
  await until(() => requests.slice(refresh1).some(r => r.method === 'jobs.get' && r.finished && !r.failed), 'r3 refresh after first write');
  await ui(`document.body.textContent.includes('2/4 个图位已有有效图片')`);
  const readableAt = Date.now();
  const after1 = planSummary(await rpc('jobs.get', detailParams));
  report.r3.writes.push({ method: 'downloads.bind', figure: 2, started: w1?.started, received: w1?.received, committed: w1?.finished, readableAt });
  check('r3_plan_now_two_of_four', after1.slots.filter(s => s.valid).length === 2);
  check('r3_plan_change_keeps_identity', after1.job === before.job && after1.account === before.account && after1.body_hash === before.body_hash
    && JSON.stringify(after1.slots.map(s => s.slot_id)) === JSON.stringify(before.slots.map(s => s.slot_id)));
  check('r3_plan_change_keeps_tabs_node', await e(`window.__r3Tabs===document.querySelector('.ice-asset-tabs')&&window.__r3Tabs.isConnected`));
  await audit('r3_plan_write');
  // 序列二：慢 jobs.get 交付窗口内的真实写入（图3）；旧快照交付不得永久回退新计划。
  await startTrace(e, 'r3-write-during-slow-detail');
  const slowStart = requests.length;
  faults.set('jobs.get', { replyDelay: 4000 });
  await click(inButton(workspace, '刷新配图'));
  await until(() => requests.slice(slowStart).some(r => r.method === 'jobs.get' && r.received && !r.finished), 'r3 slow detail captured');
  const slow = requests.slice(slowStart).find(r => r.method === 'jobs.get' && r.received && !r.finished);
  faults.delete('jobs.get');
  // 离线构造第二份真实下载（复制隔离夹具内 PNG → 真实 downloads.stage 链）。
  const extra = path.join(fixture.root, 'download-r3-extra.png');
  fs.copyFileSync(fixture.downloads.bind.file_path, extra);
  const stagedIndex = requests.length;
  const staged = await rpc('downloads.stage', { account_id: fixture.account_a, file_path: extra });
  const stagedRow = requests[stagedIndex];
  check('r3_extra_staged_via_real_service', Boolean(staged?.download_id && stagedRow && stagedRow.finished && !stagedRow.failed));
  const bind2Index = requests.length;
  await rpc('downloads.bind', { account_id: fixture.account_a, job_id: fixture.jobs.completed, figure_no: 3, slot_label: '图3', download_id: staged.download_id });
  const w2 = requests[bind2Index];
  check('r3_second_write_inside_slow_window', Boolean(w2 && w2.finished && !w2.failed) && !slow.finished && slow.received < w2.started);
  await until(() => Boolean(slow.finished), 'r3 stale snapshot delivered'); await wait(150);
  check('r3_stale_delivery_keeps_tabs', await e(`window.__r3Tabs===document.querySelector('.ice-asset-tabs')&&window.__r3Tabs.isConnected`));
  const refresh2 = requests.length; await click(inButton(workspace, '刷新配图'));
  await until(() => requests.slice(refresh2).some(r => r.method === 'jobs.get' && r.finished && !r.failed), 'r3 refresh after second write');
  await ui(`document.body.textContent.includes('3/4 个图位已有有效图片')`);
  const after2 = planSummary(await rpc('jobs.get', detailParams));
  report.r3.writes.push({ method: 'downloads.bind', figure: 3, started: w2?.started, committed: w2?.finished, staleDeliveredAt: slow.finished, identityOfSlow: slow.identity });
  check('r3_plan_converges_three_of_four', after2.slots.filter(s => s.valid).length === 3 && after2.body_hash === before.body_hash
    && JSON.stringify(after2.slots.map(s => s.slot_id)) === JSON.stringify(before.slots.map(s => s.slot_id)));
  await audit('r3_write_during_slow');
  // 序列三：后台任务状态写入（jobs.stop running→paused）→ A→B→A 往返。
  await startTrace(e, 'r3-task-write-and-handoff');
  const stopIndex = requests.length;
  await rpc('jobs.stop', { account_id: fixture.account_a, job_id: fixture.jobs.running });
  const w3 = requests[stopIndex];
  check('r3_task_write_committed', Boolean(w3 && w3.finished && !w3.failed));
  let paused = false;
  { const end = Date.now() + 8000;
    while (Date.now() < end) {
      const list = await rpc('jobs.list', { account_id: fixture.account_a });
      const row = (Array.isArray(list) ? list : []).find(j => j.job_id === fixture.jobs.running);
      if (row && row.state === 'paused') { paused = true; break; }
      await wait(200);
    } }
  check('r3_task_write_paused_running_job', paused);
  check('r3_task_write_workspace_unaffected', await e(`window.__r3Tabs===document.querySelector('.ice-asset-tabs')&&window.__r3Tabs.isConnected&&(${workspace}).contains(document.activeElement)`));
  await expectRemoval(e, 'r3-explicit-account-switch', `[...document.querySelectorAll('[role="dialog"],.ice-asset-tabs,.ice-editor')]`);
  await switchAccount(fixture.account_b); await finishAction(e);
  const switchedToB = Date.now();
  await switchAccount(fixture.account_a);
  const returnedToA = Date.now();
  await ui(`Boolean(${editBtn})`); await e(`(${editBtn}).focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await ui(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  const refresh3 = requests.length; await click(inButton(workspace, '刷新配图'));
  await until(() => requests.slice(refresh3).some(r => r.method === 'jobs.get' && r.finished && !r.failed), 'r3 refresh after return');
  await ui(`document.body.textContent.includes('3/4 个图位已有有效图片')`);
  const afterAba = planSummary(await rpc('jobs.get', detailParams));
  check('r3_after_aba_plan_persists', afterAba.slots.filter(s => s.valid).length === 3 && afterAba.body_hash === before.body_hash
    && JSON.stringify(afterAba.slots.map(s => s.slot_id)) === JSON.stringify(before.slots.map(s => s.slot_id)));
  check('r3_no_cross_account_detail_requests', requests.filter(r => r.method === 'jobs.get' && r.identity?.job === fixture.jobs.completed).every(r => r.params.account_id === fixture.account_a && r.identity?.account === fixture.account_a));
  await until(() => count('jobs.list') > pollBase, 'r3 real task poll during workspace window', 30000);
  check('r3_real_task_poll_observed', count('jobs.list') > pollBase);
  const trace3 = await audit('r3_task_write_handoff');
  trace3.handoff = { switchedToB, returnedToA, taskWrite: { started: w3?.started, committed: w3?.finished } };
  // 写审计：恰一次文章保存；计划写两次+暂存一次；任务写一次；无模型/聊天写。
  check('r3_write_audit', requests.filter(r => r.method === 'articles.save').length === 1
    && requests.filter(r => r.method === 'jobs.stop').length === 1
    && requests.filter(r => r.method === 'downloads.bind').length === 2
    && requests.filter(r => r.method === 'downloads.stage').length === 1
    && !requests.some(r => /^(prompts\.generate|chat\.send|chat\.update|chat\.submit)$/.test(r.method)));
};
