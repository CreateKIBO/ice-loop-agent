'use strict';
const { startTrace, expectRemoval, finishAction, stopTrace, auditRemovals } = require('./lifecycle-trace.cjs');
// Invoked by the existing isolated Chrome/service runner with
// ICE_LIFECYCLE_SCOPE=round2. No full 92-check replay or personal runtime.
module.exports = async function round2(ctx) {
  const { e, call, ui, btn, click, check, until, wait, rpc, count, requests, faults, fixture, report } = ctx;
  const dialog = title => `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent===${JSON.stringify(title)})`;
  const workspace = dialog('文章配图工作台'), review = dialog('最终交付审阅');
  const inButton = (root, text) => `[...(${root}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&!n.disabled)`;
  const escape = async () => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  };
  const audit = async label => {
    const trace = await stopTrace(e);
    trace.removalAudit = auditRemovals(trace, ['tabs', 'dialog', 'editor']);
    (report.d6 ??= []).push(trace);
    check(label + '_only_exact_expected_removals', !trace.removalAudit.unexpected.length && !trace.removalAudit.missingOrRepeated.length);
    return trace;
  };
  await click(`document.querySelector('button[title="键盘验收会话1"]')`);
  // B6 stays guarded while touching the browser harness; use an actual poll.
  const latest = 'candidate-expand-reading-recent-5';
  await click(`document.getElementById('${latest}')`); await click(btn('Markdown 原文'));
  await e(`void(window.__b6=document.getElementById('${latest}'))`);
  const failureStart = requests.length; faults.set('chat.get', { fail: true });
  await until(() => requests.slice(failureStart).some(r => r.method === 'chat.get' && r.failed), 'B6 failed background read');
  await ui(`document.body.textContent.includes('会话刷新失败')`);
  check('b6_failed_poll_preserves_reader', await e(`window.__b6===document.getElementById('${latest}')&&window.__b6.getAttribute('aria-expanded')==='true'&&Boolean(document.querySelector('.ice-candidate-reader pre'))`));
  faults.delete('chat.get');
  const recovered = count('chat.get'); await until(() => count('chat.get') > recovered, 'B6 recovery');
  check('b6_recovery_preserves_reader', await e(`window.__b6===document.getElementById('${latest}')&&window.__b6.getAttribute('aria-expanded')==='true'`));
  // Select by candidate identity, then derive the target by source text. No
  // hardcoded heading ordinal; verify actual scroll and the untouched other pane.
  const pair = [fixture.compare_candidates[1], fixture.compare_cr_candidate];
  for (const id of pair) await click(`[...document.getElementById('candidate-expand-${id}').parentElement.querySelectorAll('button')].find(n=>n.textContent.trim()==='加入对照')`);
  await click(btn('打开对照'));
  const compare = `document.querySelector('[role="dialog"]')`;
  const flex = `(${compare}).querySelector('.ice-dialog-body > div')`;
  const pane = `(${flex}).children[1]`;
  await click(inButton(`(${flex}).children[0]`, 'Markdown 原文'));
  const crlf = (await rpc('chat.get', { account_id: fixture.account_a, conversation_id: fixture.conversations[0] })).candidates.find(n => n.id === fixture.compare_candidates[1]).body;
  check('crlf_source_exact_without_extra_breaks', await e(`(${flex}).children[0].querySelector('pre').textContent===${JSON.stringify(crlf)}&&(${flex}).children[0].querySelectorAll('pre br').length===0`));
  await click(inButton(pane, 'Markdown 原文'));
  const cr = (await rpc('chat.get', { account_id: fixture.account_a, conversation_id: fixture.conversations[0] })).candidates.find(n => n.id === fixture.compare_cr_candidate).body;
  check('cr_source_exact', await e(`(${pane}).querySelector('pre').textContent===${JSON.stringify(cr)}`) && cr.includes('\r') && !cr.includes('\n'));
  await click(`(${pane}).querySelector('button[aria-label="复制此份原文"]')`);
  await ui(`window.__copies.at(-1)===${JSON.stringify(cr)}`); check('cr_copy_exact', true);
  await click(`(${pane}).querySelector('button[aria-controls="compare-toc-${fixture.compare_cr_candidate}"]')`);
  await e(`(()=>{window.__round2Pane=${pane};window.__round2Scroll=window.__round2Pane.querySelector('pre').parentElement;window.__round2Other=(${flex}).children[0];window.__round2OtherScroll=[...window.__round2Other.querySelectorAll('div')].find(n=>n.style.maxHeight==='460px');window.__round2OtherTop=window.__round2OtherScroll.scrollTop;})()`);
  await click(inButton(`(${pane}).querySelector('nav')`, 'tail-section'));
  const target = `[...window.__round2Pane.querySelectorAll('[data-compare-heading]')].find(n=>n.textContent.startsWith(${JSON.stringify('## tail-section\r')}))`;
  await until(async () => {
    report.crPosition = await e(`(()=>{const n=${target},s=window.__round2Scroll;return {found:Boolean(n),scroll:s.scrollTop,offset:n?.getBoundingClientRect().top-s.getBoundingClientRect().top,height:s.clientHeight,full:s.scrollHeight,head:n?.textContent.slice(0,16)};})()`);
    const p=report.crPosition; return p.found && p.scroll>30 && p.offset>=0 && p.offset<40;
  }, 'CR directory reaches actual source target', 5000);
  report.crOnly = await e(`({anchor:(${target}).dataset.compareHeading,head:(${target}).textContent.slice(0,16),scroll:window.__round2Scroll.scrollTop,other:window.__round2OtherScroll.scrollTop})`);
  check('cr_toc_scrolls_only_own_pane', await e('window.__round2OtherScroll.scrollTop===window.__round2OtherTop'));
  // Include the exact 1000px boundary and assert retained reader/TOC identity.
  report.viewport = [];
  for (const width of [1001, 1000, 999, 1000]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const started = Date.now(); let matched = false;
    try { await until(() => e(`getComputedStyle(${flex}).flexDirection===${JSON.stringify(width < 1000 ? 'column' : 'row')}`), 'exact breakpoint ' + width, 1500); matched = true; } catch {}
    report.viewport.push({ width, matched, afterMs: Date.now() - started });
    check('viewport_' + width + '_' + report.viewport.length, matched && await e(`window.__round2Pane===${pane}&&window.__round2Scroll.isConnected&&Boolean(window.__round2Pane.querySelector('pre'))&&Boolean(window.__round2Pane.querySelector('nav'))`));
  }
  await escape(); await ui('!document.querySelector(\'[role="dialog"]\')');
  await call('Emulation.clearDeviceMetricsOverride');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const edit = `[...document.querySelectorAll('[data-job-id="${fixture.jobs.completed}"] button')].find(n=>n.textContent.trim()==='编辑正文'&&!n.disabled)`;
  const openEditor = async () => { await click(edit); await ui(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`); };
  await openEditor();
  await e(`document.querySelector('.ice-editor').focus()`); await call('Input.insertText', { text: '第2轮隔离验收 ' });
  const saves = count('articles.save'); await click(btn('保存新版本'));
  await until(() => count('articles.save') > saves, 'round2 explicit save');
  await ui(`Boolean(${btn('保存新版本')})`);
  await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  const initial = [...requests].reverse().find(r => r.method === 'jobs.get' && r.identity?.job === fixture.jobs.completed && r.finished);
  check('workspace_initial_real_identity', initial?.identity.account === fixture.account_a && Boolean(initial?.identity.body_hash) && initial?.identity.slots.length > 0);
  report.initialIdentity = initial?.identity;
  const switchAccount = async account => {
    await ui(`!document.querySelector('#ice-account-select').disabled`);
    await e(`(()=>{const n=document.querySelector('#ice-account-select');n.value=${JSON.stringify(account)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await ui(`document.querySelector('#ice-account-select').value===${JSON.stringify(account)}&&!document.querySelector('#ice-account-select').disabled&&!document.querySelector('.ice-editor')&&!document.querySelector('[role="dialog"]')`);
  };
  // Two schedules: the real A response is received by the bridge before switch,
  // then held until B is active / A has returned. Never fabricate service data.
  for (const schedule of ['reply-while-b', 'reply-after-return']) {
    await startTrace(e, schedule);
    const requestStart = requests.length;
    faults.set('jobs.get', { replyDelay: 4000 });
    await click(inButton(workspace, '刷新配图'));
    await until(() => requests.slice(requestStart).some(r => r.method === 'jobs.get' && r.received && !r.finished), 'real delayed jobs.get captured');
    const slow = requests.slice(requestStart).find(r => r.method === 'jobs.get' && r.received && !r.finished);
    faults.delete('jobs.get');
    await expectRemoval(e, 'explicit-account-switch', `[...document.querySelectorAll('[role="dialog"],.ice-asset-tabs,.ice-editor')]`);
    await switchAccount(fixture.account_b); await finishAction(e);
    const switchedToB = Date.now();
    check(schedule + '_switch_happened_during_slow_read', !slow.finished && slow.params.account_id === fixture.account_a && slow.identity?.account === fixture.account_a);
    if (schedule === 'reply-while-b') {
      await until(() => Boolean(slow.finished), 'late A detail delivered while B active'); await wait(200);
      check(schedule + '_late_reply_does_not_reopen', await e(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_b)}&&!document.querySelector('.ice-asset-tabs')&&!document.querySelector('[role="dialog"]')`));
    }
    await switchAccount(fixture.account_a); const returnedToA = Date.now();
    if (schedule === 'reply-after-return') check(schedule + '_returned_before_reply', !slow.finished);
    await openEditor(); await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
    await e(`void(window.__returnedTabs=document.querySelector('.ice-asset-tabs'))`);
    await until(() => Boolean(slow.finished), 'delayed response settled'); await wait(200);
    const refreshStart = requests.length; await click(inButton(workspace, '刷新配图'));
    await until(() => requests.slice(refreshStart).some(r => r.method === 'jobs.get' && r.finished), 'returned workspace fresh detail');
    const fresh = requests.slice(refreshStart).find(r => r.method === 'jobs.get' && r.finished);
    check(schedule + '_fresh_job_account_hash_and_slots', !fresh.failed && JSON.stringify(fresh.identity) === JSON.stringify(initial.identity));
    check(schedule + '_returned_workspace_retains_tabs_and_focus', await e(`window.__returnedTabs===document.querySelector('.ice-asset-tabs')&&window.__returnedTabs.isConnected&&(${workspace}).contains(document.activeElement)`));
    const trace = await audit(schedule);
    trace.reply = { started: slow.started, received: slow.received, finished: slow.finished, params: slow.params, identity: slow.identity, switchedToB, returnedToA };
    check(schedule + '_b_interval_has_no_tabs_or_dialogs', trace.samples.some(s => s.account === fixture.account_b) && trace.samples.filter(s => s.at >= switchedToB && s.at < returnedToA && s.account === fixture.account_b).every(s => !s.tabs.length && !s.dialogs.length && !s.editor));
    check(schedule + '_no_cross_account_detail_requests', requests.slice(requestStart).filter(r => r.method === 'jobs.get').every(r => r.params.account_id === fixture.account_a && r.identity?.account === fixture.account_a));
  }
  await click(inButton(workspace, '关闭配图工作台')); await ui(`!(${workspace})`);
  const reviewTrigger = `document.querySelector('.ice-editor-bar__actions button[title="核对标题、正文、配图与检查结果，确认后才能导出发布就绪包"]')`;
  const imageNavigation = `[...(${review}).querySelectorAll('button')].find(n=>/^准备图[0-9]+$/.test(n.textContent.trim())&&!n.disabled)`;
  // Normal motion, failed cached review, then two complete review/image round trips.
  await click(reviewTrigger); await ui(`Boolean(${review})&&Boolean(${imageNavigation})`);
  await ui(`Boolean(${inButton(review, '刷新')})`);
  faults.set('articles.delivery_snapshot', { fail: true });
  const failure = requests.length; await click(inButton(review, '刷新'));
  await until(() => requests.slice(failure).some(r => r.method === 'articles.delivery_snapshot' && r.failed), 'explicit delivery snapshot failure');
  await ui(`(${review}).textContent.includes('读取审阅快照失败')`);
  check('failed_review_keeps_enabled_image_navigation', await e(`Boolean(${imageNavigation})`));
  faults.delete('articles.delivery_snapshot');
  await startTrace(e, 'normal-motion-delivery-roundtrips');
  for (let trip = 1; trip <= 2; trip++) {
    await expectRemoval(e, 'review-to-images-' + trip, `[${review}]`);
    await click(imageNavigation); await ui(`Boolean(${workspace})&&Boolean(document.querySelector('.ice-asset-tabs'))&&!(${review})`); await finishAction(e);
    await ui(`(${workspace}).contains(document.activeElement)`);
    await e(`void(window.__normalTabs=document.querySelector('.ice-asset-tabs'))`);
    const refresh = requests.length; await click(inButton(workspace, '刷新配图'));
    await until(() => requests.slice(refresh).some(r => r.method === 'jobs.get' && r.finished), 'normal handoff detail');
    if (trip === 1) {
      const poll = count('jobs.list'); await until(() => count('jobs.list') > poll, 'real job poll in normal motion workspace');
    }
    check('normal_trip_' + trip + '_retains_workspace_tabs_and_focus', await e(`window.__normalTabs===document.querySelector('.ice-asset-tabs')&&window.__normalTabs.isConnected&&(${workspace}).contains(document.activeElement)`));
    await expectRemoval(e, 'explicit-close-images-' + trip, `[${workspace},document.querySelector('.ice-asset-tabs')]`);
    await click(inButton(workspace, '关闭配图工作台')); await ui(`!(${workspace})`); await finishAction(e);
    await click(reviewTrigger); await ui(`Boolean(${review})&&Boolean(${imageNavigation})`);
    await ui(`(${review}).contains(document.activeElement)`);
  }
  const normal = await audit('normal_motion_roundtrips');
  check('normal_motion_observed_throughout', normal.samples.every(s => s.motion === 'normal' && s.account === fixture.account_a));
  check('normal_roundtrips_real_job_identity', requests.some(r => r.method === 'jobs.get' && r.started >= normal.started && r.finished <= normal.finished && JSON.stringify(r.identity) === JSON.stringify(initial.identity)));
  check('only_one_explicit_save_no_model_or_task_mutation', requests.filter(r => r.method === 'articles.save').length === 1 && !requests.some(r => /^(prompts.generate|chat.send|jobs\.(resume|stop|restore))$/.test(r.method)));
  await click(inButton(review, '关闭审阅')); await ui(`!(${review})`);
};
