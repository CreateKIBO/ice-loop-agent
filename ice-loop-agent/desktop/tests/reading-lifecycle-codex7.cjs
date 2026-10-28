'use strict';
// Real renderer state with a delayed rejection BEFORE prompts.generate dispatch.
// Never let the model method reach DesktopService, even in an offline fixture.
module.exports = async function codex7({ e, call, ui, click, check, until, rpc, requests, faults, fixture, evidence, report }) {
  const prompt = `document.querySelector('section[aria-label="生图提示词"]')`;
  const button = label => `[...(${prompt}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`;
  const input = `(${prompt}).querySelector('input[aria-label="本篇模型调用上限"]')`;
  const preview = `(${prompt}).querySelector('[aria-label="最新预算核对"]')`;
  const field = value => e(`(()=>{const n=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const params = { account_id: fixture.account_a, job_id: fixture.jobs.completed }, before = await rpc('budgets.get', params), start = requests.length;
  report.c7 = { boundary: 'two injected delayed model-method rejections before service dispatch; no model/consumer', before };
  await e(`void(window.__c7Prompt=(${prompt}).querySelector('textarea'));void(window.__c7Tabs=document.querySelector('.ice-asset-tabs'));void(window.__c7Generate=${button('按文章与品牌 AI 重拟')})`);
  const retained = `window.__c7Prompt===(${prompt}).querySelector('textarea')&&window.__c7Tabs===document.querySelector('.ice-asset-tabs')&&window.__c7Tabs.isConnected`;
  try {
    await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('60');
    faults.set('prompts.generate', { fail: true, delay: 2400 });
    const first = requests.length;
    await e(`window.__c7Generate.scrollIntoView({block:'nearest'});window.__c7Width=window.__c7Generate.getBoundingClientRect().width;window.__c7Generate.focus();window.__c7Generate.click();window.__c7Generate.click()`);
    await until(() => requests.slice(first).some(r => r.method === 'prompts.generate' && !r.finished), 'c7 held pre-dispatch generation failure');
    check('c7_generation_pending_and_same_tick_deduplicated', requests.slice(first).filter(r => r.method === 'prompts.generate').length === 1 && await e('window.__c7Generate.disabled'));
    check('c7_generation_loading_has_busy_rail', await e(`window.__c7Generate.getAttribute('aria-busy')==='true'&&!!window.__c7Generate.querySelector('.ice-activity-rail')`));
    check('c7_generation_label_and_width_stay_stable', await e(`window.__c7Generate.textContent.trim()==='按文章与品牌 AI 重拟'&&Math.abs(window.__c7Generate.getBoundingClientRect().width-window.__c7Width)<1`));
    check('c7_budget_save_and_read_disabled_by_generation', await e(`(${button('保存本篇预算')}).disabled&&(${button('读取最新预算')}).disabled`));
    check('c7_prompt_and_budget_draft_remain_editable', await e(`!window.__c7Prompt.disabled&&!(${input}).disabled&&(${input}).value==='60'`));
    await e(`(${button('保存本篇预算')}).click();(${button('读取最新预算')}).click()`);
    check('c7_conflicting_actions_do_not_dispatch', !requests.slice(first).some(r => /^(budgets.save|budgets.get|prompts.save)$/.test(r.method)));
    await e(`(${button('取消预算调整')}).focus()`); await click(button('取消预算调整')); await ui(`!(${input})`);
    check('c7_budget_cancel_does_not_cancel_or_unmount_generation', requests.slice(first).some(r => r.method === 'prompts.generate' && !r.finished) && await e(`window.__c7Generate.disabled&&(${retained})`));
    await e(`(()=>{window.__c7Prompt.focus();window.__c7Text=window.__c7Prompt.value+${JSON.stringify('\n第6轮重拟期间继续编辑')};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(window.__c7Prompt,window.__c7Text);window.__c7Prompt.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => requests.slice(first).some(r => r.method === 'prompts.generate' && r.failed && r.injected && !r.dispatched), 'c7 first pre-dispatch rejection');
    await ui('!window.__c7Generate.disabled');
    check('c7_generation_failure_keeps_edits_and_prompt_focus', await e(`window.__c7Prompt.value===window.__c7Text&&document.activeElement===window.__c7Prompt&&(${prompt}).textContent.includes('你已输入的内容保留')&&(${retained})`));
    await until(() => requests.slice(first).some(r => r.method === 'budgets.get' && r.source === 'renderer' && r.finished && !r.failed), 'c7 post-generation real budget read');

    await click(button('调整本篇预算')); await ui(`Boolean(${input})`); await field('65');
    await e(`(${button('读取最新预算')}).focus()`); await click(button('读取最新预算')); await ui(`Boolean(${preview})`);
    await e(`void(window.__c7Preview=${preview})`);
    await call('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 1, mobile: false });
    const second = requests.length; await e('window.__c7Generate.click()');
    await until(() => requests.slice(second).some(r => r.method === 'prompts.generate' && !r.finished), 'c7 second held pre-dispatch failure');
    check('c7_preview_choices_disabled_during_generation', await e(`(${button('保留输入并载入版本')}).disabled&&(${button('采用最新上限')}).disabled`));
    check('c7_preview_read_disabled_during_generation', await e(`(${button('读取最新预算')}).disabled`));
    check('c7_pending_copy_explains_budget_controls', await e(`(${prompt}).textContent.includes('预算操作将在重拟结束后恢复')`));
    check('c7_reduced_motion_loading_is_static', await e(`window.__c7Generate.querySelector('.ice-activity-rail')?.getAttribute('data-animated')==='false'`));
    await e(`(${button('保留输入并载入版本')}).click();(${button('采用最新上限')}).click();(${button('读取最新预算')}).click()`);
    check('c7_blocked_choices_preserve_preview_and_draft', await e(`window.__c7Preview===${preview}&&(${input}).value==='65'&&(${retained})`)
      && !requests.slice(second).some(r => /^(budgets.save|budgets.get|prompts.save)$/.test(r.method)));
    await e(`(${preview}).scrollIntoView({block:'nearest'})`);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync(require('node:path').join(evidence, 'generation-budget-busy-narrow.png'), Buffer.from(screenshot.data, 'base64'));
    await until(() => requests.slice(second).some(r => r.method === 'prompts.generate' && r.failed && r.injected && !r.dispatched), 'c7 second pre-dispatch rejection');
    await ui('!window.__c7Generate.disabled');
    check('c7_failure_restores_preview_actions_without_discarding', await e(`!(${button('保留输入并载入版本')}).disabled&&!(${button('采用最新上限')}).disabled&&!(${button('读取最新预算')}).disabled&&window.__c7Preview===${preview}&&(${input}).value==='65'`));
    await click(button('保留输入并载入版本')); await ui(`!(${preview})`); await click(button('取消预算调整')); await ui(`!(${input})`);
    await call('Emulation.clearDeviceMetricsOverride');
    const after = await rpc('budgets.get', params); report.c7.after = after;
    check('c7_budget_and_used_count_unchanged', JSON.stringify(after.job) === JSON.stringify(before.job));
    const generation = requests.slice(start).filter(r => r.method === 'prompts.generate'); report.c7.generation = generation;
    check('c7_no_model_dispatch_or_budget_prompt_approval_writes', generation.length === 2 && generation.every(r => r.source === 'renderer' && r.failed && r.injected && !r.dispatched)
      && !requests.slice(start).some(r => /^(budgets.save|prompts.save|chat.send|jobs.resume|approvals.decide|execution.approve)$/.test(r.method)));
  } finally { faults.delete('prompts.generate'); }
};
