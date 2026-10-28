'use strict';
// Extends codex5 without weakening its assertions. Recovery uses actual
// budgets.get/save; only one request failure/response delay is test-injected.
module.exports = async function codex6({ e, call, ui, click, check, until, rpc, requests, faults, fixture, evidence, report }) {
  const prompt = `document.querySelector('section[aria-label="生图提示词"]')`;
  const button = label => `[...(${prompt}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`;
  const input = `(${prompt}).querySelector('input[aria-label="本篇模型调用上限"]')`;
  const preview = `(${prompt}).querySelector('[aria-label="最新预算核对"]')`;
  const field = value => e(`(()=>{const n=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const params = { account_id: fixture.account_a, job_id: fixture.jobs.completed }, start = requests.length;
  const initial = await rpc('budgets.get', params);
  report.c6 = { boundary: 'explicit renderer read/preview/apply/save; genuine CAS; no model/consumer', initial };
  const retained = `window.__c5Tabs===document.querySelector('.ice-asset-tabs')&&window.__c5Tabs.isConnected&&window.__c5Prompt===(${prompt}).querySelector('textarea')&&window.__c5Prompt.value===window.__c5Text`;
  await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('40');
  const firstConflict = requests.length; await click(button('保存本篇预算'));
  await until(() => requests.slice(firstConflict).some(r => r.method === 'budgets.save' && r.failed && r.received && !r.injected), 'c6 original stale snapshot genuinely rejected');
  await ui(`(${prompt}).textContent.includes('预算调整未完成')`);
  check('c6_reproduces_conflict_before_recovery', initial.job.limit === 25 && await e(`(${input}).value==='40'&&(${prompt}).textContent.includes('内容已被更新')`));
  const hasRead = await e(`Boolean(${button('读取最新预算')})`);
  check('c6_conflict_has_explicit_read_entry', hasRead);
  if (!hasRead) { report.c6.blocker = 'No in-form read entry; cancelling/reopening repeats the stale snapshot'; return; }

  try {
    // Read failure must preserve both the unsaved limit and independent errors.
    faults.set('budgets.get', { fail: true, delay: 1200 });
    const failedRead = requests.length;
    await e(`(()=>{const b=${button('读取最新预算')};b.focus();b.click();b.click();})()`);
    await until(() => requests.slice(failedRead).some(r => r.method === 'budgets.get' && !r.finished), 'c6 pending manual read');
    check('c6_read_has_own_loading_feedback', await e(`(()=>{const b=${button('读取最新预算')},s=${button('保存本篇预算')};return b.disabled&&b.getAttribute('aria-busy')==='true'&&!!b.querySelector('.ice-activity-rail')&&s.disabled&&s.getAttribute('aria-busy')!=='true';})()`));
    await until(() => requests.slice(failedRead).some(r => r.method === 'budgets.get' && r.failed), 'c6 injected manual read failure');
    await ui(`(${prompt}).textContent.includes('最新预算读取失败')`);
    check('c6_failed_read_preserves_draft_and_independent_errors', await e(`(${input}).value==='40'&&(${prompt}).textContent.includes('内容已被更新')&&(${prompt}).textContent.includes('Injected offline read failure: prompts.generate')&&(${retained})`));
    check('c6_failed_read_did_not_write_or_repeat', !requests.slice(failedRead).some(r => r.method === 'budgets.save')
      && requests.slice(failedRead).filter(r => r.method === 'budgets.get').length === 1);
    check('c6_failed_read_restores_read_button_focus', await e(`document.activeElement===${button('读取最新预算')}`));
    faults.delete('budgets.get'); faults.set('budgets.get', { replyDelay: 1200 });
    const recovery = requests.length; await click(button('读取最新预算'));
    await until(() => requests.slice(recovery).some(r => r.method === 'budgets.get' && r.received && !r.finished), 'c6 real read captured');
    await e('window.__c5Prompt.focus()');
    await ui(`Boolean(${preview})`); faults.delete('budgets.get');
    check('c6_preview_keeps_input_and_shows_actual_budget', await e(`(${input}).value==='40'&&(${preview}).textContent.includes('当前上限 25')&&(${preview}).textContent.includes(${JSON.stringify('已用 ' + initial.job.used)})&&(${retained})`));
    check('c6_preview_does_not_steal_prompt_focus', await e('document.activeElement===window.__c5Prompt'));
    check('c6_preview_requires_choice_before_save', await e(`(${button('保存本篇预算')}).disabled`));
    await e(`(${button('保存本篇预算')}).click()`);
    check('c6_read_preview_has_no_automatic_write', !requests.slice(recovery).some(r => r.method === 'budgets.save'));
    check('c6_reduced_motion_preview_is_static', await e(`(${preview}).getAnimations().every(a=>a.playState!=='running')`));
    await click(button('保留输入并载入版本'));
    await ui(`!(${preview})`);
    check('c6_keep_input_rebases_only_after_explicit_choice', await e(`(${input}).value==='40'&&!(${button('保存本篇预算')}).disabled&&!(${prompt}).textContent.includes('预算调整未完成')&&!(${prompt}).textContent.includes('最新预算读取失败')&&(${prompt}).textContent.includes('尚未保存')`));
    check('c6_rebase_keeps_prompt_and_generation_error', await e(`(${retained})&&(${prompt}).textContent.includes('Injected offline read failure: prompts.generate')`));
    check('c6_rebase_still_has_not_written', (await rpc('budgets.get', params)).job.limit === 25);
    const explicitSave = requests.length; await click(button('保存本篇预算'));
    await until(() => requests.slice(explicitSave).some(r => r.method === 'budgets.save' && r.finished && !r.failed), 'c6 explicit save with refreshed version');
    await ui(`!(${input})&&!(${button('调整本篇预算')}).disabled`);
    const saved = await rpc('budgets.get', params); report.c6.saved = saved;
    const write = requests.slice(explicitSave).find(r => r.method === 'budgets.save');
    check('c6_explicit_save_uses_new_hash_and_preserves_usage', saved.job.limit === 40 && saved.job.used === initial.job.used
      && write.source === 'renderer' && write.params.limits_hash === initial.job.limits_hash && saved.job.limits_hash !== initial.job.limits_hash);

    // A second genuine conflict exercises choosing the external writer's value.
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('55');
    const external = await rpc('budgets.save', { ...params, scope: 'job', limit: 32, limits_hash: saved.job.limits_hash });
    const secondConflict = requests.length; await click(button('保存本篇预算'));
    await until(() => requests.slice(secondConflict).some(r => r.method === 'budgets.save' && r.received && r.failed && !r.injected), 'c6 second genuine conflict');
    await e(`(${button('读取最新预算')}).focus()`); await click(button('读取最新预算')); await ui(`Boolean(${preview})`);
    check('c6_new_preview_does_not_use_previous_snapshot', await e(`(${input}).value==='55'&&(${preview}).textContent.includes('当前上限 32')`));
    report.c6.focusAfterPreview = await e(`({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent?.slice(0,120)})`);
    check('c6_preview_focus_is_inside_review_region', await e(`(${preview}).contains(document.activeElement)`));
    const adoptStart = requests.length; await click(button('采用最新上限')); await ui(`!(${preview})`);
    check('c6_adopt_latest_value_is_explicit_and_does_not_save', await e(`(${input}).value==='32'&&document.activeElement===${input}`)
      && !requests.slice(adoptStart).some(r => r.method === 'budgets.save'));
    await call('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 1, mobile: false });
    await e(`(${button('读取最新预算')}).focus()`); await click(button('读取最新预算')); await ui(`Boolean(${preview})`);
    check('c6_narrow_preview_has_no_horizontal_overflow', await e(`(()=>{const n=${preview},r=n.getBoundingClientRect();return n.scrollWidth<=n.clientWidth+1&&r.left>=0&&r.right<=innerWidth;})()`));
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync(require('node:path').join(evidence, 'budget-recovery-narrow.png'), Buffer.from(screenshot.data, 'base64'));
    await click(button('取消预算调整')); await ui(`!(${input})`);
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`);
    check('c6_cancel_reopen_has_fresh_base_without_abandoned_preview', await e(`(${input}).value==='32'&&!(${preview})&&!(${prompt}).textContent.includes('尚未保存')&&!(${prompt}).textContent.includes('最新预算读取失败')&&(${retained})`));
    await click(button('取消预算调整')); await call('Emulation.clearDeviceMetricsOverride');
    const final = await rpc('budgets.get', params); report.c6.final = final;
    check('c6_external_value_and_used_count_survive_read_choices', final.job.limit === 32 && final.job.used === initial.job.used && final.job.limits_hash === external.job.limits_hash);
    const writes = requests.slice(start).filter(r => r.method === 'budgets.save'); report.c6.writes = writes;
    check('c6_write_audit_only_one_recovered_save_and_two_real_conflicts', writes.filter(r => r.source === 'renderer' && !r.failed).length === 1
      && writes.filter(r => r.source === 'renderer' && r.failed && !r.injected).length === 2 && writes.filter(r => r.source === 'harness' && !r.failed).length === 1);
    check('c6_no_model_prompt_or_consumer_dispatch', !requests.slice(start).some(r => /^(prompts\.(save|generate)|chat.send|jobs.resume|approvals.decide|execution.approve)$/.test(r.method)));
  } finally { faults.delete('budgets.get'); }
};
