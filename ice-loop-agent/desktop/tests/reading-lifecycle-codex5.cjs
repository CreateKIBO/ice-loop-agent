'use strict';
// Serial extension of codex4. Real offline budgets.save/CAS; only response
// delivery is delayed and follow-up budgets.get is failed before dispatch.
module.exports = async function codex5({ e, call, ui, click, check, until, rpc, requests, faults, fixture, evidence, report }) {
  const workspace = `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent==='文章配图工作台')`;
  const prompt = `(${workspace}).querySelector('section[aria-label="生图提示词"]')`;
  const button = label => `[...(${prompt}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`;
  const input = `(${prompt}).querySelector('input[aria-label="本篇模型调用上限"]')`;
  const field = value => e(`(()=>{const n=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const params = { account_id: fixture.account_a, job_id: fixture.jobs.completed };
  const before = await rpc('budgets.get', params), start = requests.length;
  report.c5 = { boundary: 'real offline service receipts/CAS, injected follow-up read failure, no model/consumer', before };
  await e(`(()=>{window.__c5Tabs=document.querySelector('.ice-asset-tabs');window.__c5Prompt=(${prompt}).querySelector('textarea');window.__c5Text=window.__c5Prompt.value+${JSON.stringify('\n第3轮预算保存期间保留的修改')};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(window.__c5Prompt,window.__c5Text);window.__c5Prompt.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const retained = `window.__c5Tabs===document.querySelector('.ice-asset-tabs')&&window.__c5Tabs.isConnected&&window.__c5Prompt===(${prompt}).querySelector('textarea')&&window.__c5Prompt.value===window.__c5Text&&(${prompt}).textContent.includes('未保存修改')`;
  await e(`(${button('调整本篇预算')}).scrollIntoView({block:'nearest'});(${button('调整本篇预算')}).focus()`);
  await click(button('调整本篇预算')); await ui(`Boolean(${input})`);
  check('c5_open_focuses_budget_input', await e(`document.activeElement===${input}`));
  check('c5_focused_input_is_visible', await e(`(()=>{const n=${input},r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n;})()`));
  await e(`(${button('取消预算调整')}).focus()`); await click(button('取消预算调整'));
  await ui(`!(${input})`);
  check('c5_cancel_returns_focus_to_budget_entry', await e(`document.activeElement===${button('调整本篇预算')}`));

  try {
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('30');
    faults.set('budgets.save', { replyDelay: 1800 }); faults.set('budgets.get', { fail: true });
    const saveStart = requests.length;
    await e(`(()=>{const b=${button('保存本篇预算')};b.focus();window.__c5SaveWidth=b.getBoundingClientRect().width;b.click();b.click();})()`);
    await until(() => requests.slice(saveStart).some(r => r.method === 'budgets.save' && r.received && !r.finished), 'c5 real save handler returned but receipt held');
    check('c5_saving_button_has_busy_rail', await e(`(()=>{const b=${button('保存本篇预算')};return b.disabled&&b.getAttribute('aria-busy')==='true'&&!!b.querySelector('.ice-activity-rail');})()`));
    check('c5_saving_label_and_width_preserved', await e(`(()=>{const b=${button('保存本篇预算')};return b.textContent.trim()==='保存本篇预算'&&Math.abs(b.getBoundingClientRect().width-window.__c5SaveWidth)<1;})()`));
    check('c5_saving_controls_locked_prompt_editable', await e(`(${input}).disabled&&(${button('取消预算调整')}).disabled&&!window.__c5Prompt.disabled`));
    await until(() => requests.slice(saveStart).some(r => r.method === 'budgets.get' && r.injected && r.failed), 'c5 post-save read failure');
    await ui(`!(${input})&&!(${button('调整本篇预算')}).disabled`);
    check('c5_saved_receipt_updates_usage_despite_failed_refresh', await e(`(${prompt}).textContent.includes(${JSON.stringify('本篇调用：' + before.job.used + '/30')})`));
    check('c5_saved_and_read_failure_are_distinguished', await e(`(${prompt}).textContent.includes('本篇预算已保存')&&(${prompt}).textContent.includes('用量刷新失败')&&!(${prompt}).textContent.includes('预算调整未完成')`));
    report.c5.focusAfterSave = await e(`({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent?.slice(0,120)})`);
    check('c5_save_completion_returns_focus', await e(`document.activeElement===${button('调整本篇预算')}`));
    check('c5_save_keeps_prompt_edits_and_nodes', await e(retained));
    check('c5_save_keeps_independent_generation_error', await e(`(${prompt}).textContent.includes('Injected offline read failure: prompts.generate')`));
    faults.delete('budgets.get'); faults.delete('budgets.save');
    const persisted = await rpc('budgets.get', params); report.c5.persistedAfterFailedRefresh = persisted;
    check('c5_real_save_persisted_and_usage_preserved', persisted.job.limit === 30 && persisted.job.used === before.job.used && persisted.job.limits_hash !== before.job.limits_hash);
    check('c5_double_click_did_not_repeat_budget_write', requests.slice(saveStart).filter(r => r.method === 'budgets.save' && r.source === 'renderer').length === 1);
    const retryStart = requests.length;
    await click(button('重新读取预算'));
    await until(() => requests.slice(retryStart).some(r => r.method === 'budgets.get' && r.source === 'renderer' && r.finished && !r.failed), 'c5 manual read recovery');
    await ui(`!Boolean(${button('重新读取预算')})`);
    check('c5_read_retry_does_not_resubmit_save', !requests.slice(retryStart).some(r => r.method === 'budgets.save') && await e(`(${prompt}).textContent.includes(${JSON.stringify('本篇调用：' + before.job.used + '/30')})&&!(${prompt}).textContent.includes('用量刷新失败')`));

    // If the user moves into the prompt while a write is in flight, completion
    // must not pull focus back to the entry button.
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('35');
    faults.set('budgets.save', { replyDelay: 1500 });
    const secondStart = requests.length; await click(button('保存本篇预算'));
    await until(() => requests.slice(secondStart).some(r => r.method === 'budgets.save' && r.received && !r.finished), 'c5 second save held receipt');
    await e('window.__c5Prompt.focus()');
    await ui(`!(${input})&&!(${button('调整本篇预算')}).disabled`); faults.delete('budgets.save');
    check('c5_save_does_not_steal_prompt_focus', await e('document.activeElement===window.__c5Prompt'));
    check('c5_success_notice_is_polite', await e(`Boolean((${prompt}).querySelector('.ice-budget-feedback[role="status"]'))`));
    check('c5_reduced_motion_success_feedback_is_static', await e(`(()=>{const n=(${prompt}).querySelector('.ice-budget-feedback');return !!n&&matchMedia('(prefers-reduced-motion: reduce)').matches&&n.getAnimations().every(a=>a.playState!=='running');})()`));

    // Genuine compare-and-swap rejection: a separate real writer changes the
    // saved version after the renderer captures its editing snapshot.
    const fresh = await rpc('budgets.get', params);
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('40');
    await rpc('budgets.save', { ...params, scope: 'job', limit: 25, limits_hash: fresh.job.limits_hash });
    const conflictStart = requests.length; await click(button('保存本篇预算'));
    await until(() => requests.slice(conflictStart).some(r => r.method === 'budgets.save' && r.failed && r.received && !r.injected), 'c5 real limits_hash conflict');
    await ui(`(${prompt}).textContent.includes('预算调整未完成')`);
    check('c5_real_conflict_preserves_form_and_classified_error', await e(`(${input}).value==='40'&&(${prompt}).textContent.includes('内容已被更新')&&!(${prompt}).textContent.includes('本篇预算已保存')`));
    await click(button('取消预算调整')); await ui(`!(${input})`);
    check('c5_conflict_cancel_clears_only_form_error', await e(`!(${prompt}).textContent.includes('预算调整未完成')&&(${prompt}).textContent.includes('Injected offline read failure: prompts.generate')&&(${retained})`));
    const external = await rpc('budgets.get', params); report.c5.afterConflict = external;
    check('c5_conflict_does_not_overwrite_external_budget', external.job.limit === 25 && external.job.used === before.job.used && external.job.limits_hash !== fresh.job.limits_hash);
    const writes = requests.slice(start).filter(r => r.method === 'budgets.save'); report.c5.writes = writes;
    check('c5_write_audit_exactly_two_renderer_saves_and_one_conflict', writes.filter(r => r.source === 'renderer' && !r.failed).length === 2
      && writes.filter(r => r.source === 'renderer' && r.failed && !r.injected).length === 1 && writes.filter(r => r.source === 'harness' && !r.failed).length === 1);
    check('c5_no_prompt_model_approval_or_consumer_dispatch', !requests.slice(start).some(r => /^(prompts\.(save|generate)|chat.send|jobs.resume|approvals.decide|execution.approve)$/.test(r.method)));
    await call('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 1, mobile: false });
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`);
    check('c5_narrow_budget_controls_within_panel', await e(`(()=>{const n=(${input}).closest('.ice-asset-card'),r=n.getBoundingClientRect();return n.scrollWidth<=n.clientWidth+1&&r.left>=0&&r.right<=innerWidth;})()`));
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync(require('node:path').join(evidence, 'budget-narrow.png'), Buffer.from(screenshot.data, 'base64'));
    await click(button('取消预算调整')); await call('Emulation.clearDeviceMetricsOverride');
  } finally { faults.delete('budgets.save'); faults.delete('budgets.get'); }
};
