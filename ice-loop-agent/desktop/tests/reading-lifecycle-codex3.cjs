'use strict';

// Desktop continuation round 1. Same-article consumer UI coverage is still open:
// completed-only editor entry + terminal jobs.resume guard prevent a natural
// resume of the already-open article. This scope does not enable a consumer.
module.exports = async function codex3({ e, ui, click, check, until, rpc, requests, faults, fixture, report }) {
  const workspace = `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent==='文章配图工作台')`;
  const prompt = `(${workspace}).querySelector('section[aria-label="生图提示词"]')`;
  const button = label => `[...(${prompt}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)}&&!n.disabled)`;
  const input = `(${prompt}).querySelector('input[aria-label="本篇模型调用上限"]')`;
  const field = async value => e(`(()=>{const n=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  report.c3 = { boundary: 'real renderer budget validation/cancel/reopen; injected failures before dispatch; no same-article consumer claim' };
  // Readable runtime evidence for the recovery blocker. The actual resume RPC
  // must reject this completed article without changing its body or plan.
  const params = { account_id: fixture.account_a, job_id: fixture.jobs.completed };
  const identity = detail => ({ job: detail.job.job_id, article: detail.article.article_id,
    account: detail.article.spec.account_id, state: detail.job.state, node: detail.job.current_node,
    body_hash: detail.body_hash, slots: detail.slots.map(s => [s.slot_id, s.content_hash, s.valid]) });
  const before = identity(await rpc('jobs.get', params));
  let rejection;
  try { await rpc('jobs.resume', params); } catch (error) { rejection = error.message; }
  const after = identity(await rpc('jobs.get', params));
  report.c3.recoveryBlocker = { before, rejection, after };
  check('c3_completed_article_resume_rejected_without_plan_change', rejection === '该任务不能继续' && before.state === 'completed' && JSON.stringify(before) === JSON.stringify(after));
  check('c3_existing_editor_entries_require_completed', await e(`Boolean([...document.querySelectorAll('[data-job-id="${fixture.jobs.completed}"] button')].find(n=>n.textContent.trim()==='编辑正文'))&&!([...document.querySelectorAll('[data-job-id="${fixture.jobs.paused}"] button')].some(n=>n.textContent.trim()==='编辑正文'))`));
  await ui(`Boolean(${button('调整本篇预算')})`);
  await e(`(()=>{window.__c3Tabs=document.querySelector('.ice-asset-tabs');const n=(${prompt}).querySelector('textarea[aria-label="当前图位生图提示词"]');window.__c3Prompt=n;window.__c3Text=n.value+${JSON.stringify('\n预算取消时保留的未保存修改')};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,window.__c3Text);n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const retained = `window.__c3Tabs===document.querySelector('.ice-asset-tabs')&&window.__c3Prompt===(${prompt}).querySelector('textarea[aria-label="当前图位生图提示词"]')&&window.__c3Prompt.value===window.__c3Text&&(${prompt}).textContent.includes('未保存修改')`;
  const writeStart = requests.length;
  await click(button('调整本篇预算'));
  await field('0');
  await click(button('保存本篇预算'));
  await ui(`(${prompt}).textContent.includes('本篇上限需为')`);
  report.c3.validationFailure = await e(`(${prompt}).innerText`);
  check('c3_invalid_budget_rejected_without_write', !requests.slice(writeStart).some(r => r.method === 'budgets.save'));
  await click(button('取消预算调整'));
  report.c3.afterCancel = await e(`(${prompt}).innerText`);
  check('c3_cancel_clears_abandoned_budget_error', await e(`!(${input})&&!(${prompt}).textContent.includes('本篇上限需为')`));
  check('c3_cancel_keeps_prompt_edits_and_nodes', await e(retained));
  await click(button('调整本篇预算'));
  check('c3_reopen_starts_with_saved_limit_and_no_old_error', await e(`Number((${input}).value)>0&&!(${prompt}).textContent.includes('本篇上限需为')`));
  // An injected request failure must have the same cancel lifecycle as validation.
  // The bridge fails before dispatch, so no budget is changed by this check.
  faults.set('budgets.save', { fail: true });
  await field('100');
  const failedStart = requests.length;
  await click(button('保存本篇预算'));
  await until(() => requests.slice(failedStart).some(r => r.method === 'budgets.save' && r.failed), 'c3 budget save injected failure');
  await ui(`(${prompt}).textContent.includes('Injected offline read failure: budgets.save')`);
  report.c3.saveFailure = await e(`(${prompt}).innerText`);
  faults.delete('budgets.save');
  await click(button('取消预算调整'));
  check('c3_cancel_clears_failed_save_error', await e(`!(${prompt}).textContent.includes('Injected offline read failure: budgets.save')`));
  check('c3_failed_save_cancel_keeps_prompt_edits', await e(retained));
  // Keep an independent generation error visible when only the edit form is cancelled.
  // Fail before dispatch: no model, billing or generated output is involved.
  faults.set('prompts.generate', { fail: true });
  await click(button('按文章与品牌 AI 重拟'));
  await ui(`(${prompt}).textContent.includes('Injected offline read failure: prompts.generate')`);
  faults.delete('prompts.generate');
  await click(button('调整本篇预算'));
  await field('0');
  await click(button('保存本篇预算'));
  await click(button('取消预算调整'));
  check('c3_cancel_preserves_independent_generation_error', await e(`(${prompt}).textContent.includes('Injected offline read failure: prompts.generate')&&!(${prompt}).textContent.includes('本篇上限需为')`));
  check('c3_independent_error_keeps_prompt_edits', await e(retained));
  await click(button('放弃修改'));
  const generation = requests.filter(r => r.method === 'prompts.generate');
  check('c3_no_model_dispatch_approval_prompt_or_successful_budget_write', generation.length === 1 && generation[0].injected && !generation[0].dispatched
    && !requests.some(r => /^(prompts\.save|chat\.send|approvals\.decide|execution\.approve)$/.test(r.method))
    && requests.filter(r => r.method === 'jobs.resume').length === 1 && requests.find(r => r.method === 'jobs.resume').failed
    && !requests.slice(writeStart).some(r => r.method === 'budgets.save' && !r.failed));
};
