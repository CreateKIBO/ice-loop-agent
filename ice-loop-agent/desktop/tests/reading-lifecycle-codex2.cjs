'use strict';
const { startTrace, expectRemoval, finishAction, stopTrace, auditRemovals } = require('./lifecycle-trace.cjs');

// After round3: completed article's editor/workspace stays open while a separate
// production task really runs, receives stop, then returns from its original node.
// This covers in-flight stop, not consumer-generated plans on the open article.
module.exports = async function codex2({ e, ui, click, check, until, rpc, requests, faults, fixture, report }) {
  const workspace = `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent==='文章配图工作台')`;
  const button = (root, label) => `[...(${root}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)}&&!n.disabled)`;
  const params = { account_id: fixture.account_a, job_id: fixture.jobs.completed };
  const identity = detail => ({ job: detail.job.job_id, article: detail.article.article_id,
    account: detail.article.spec.account_id, body_hash: detail.body_hash,
    slots: detail.slots.map(s => ({ slot: s.slot_id, hash: s.content_hash, valid: Boolean(s.valid) })) });
  const before = identity(await rpc('jobs.get', params));
  await e(`void(window.__c2Tabs=document.querySelector('.ice-asset-tabs'));void(window.__c2Editor=document.querySelector('.ice-editor'));void(window.__c2Dialog=${workspace})`);
  await startTrace(e, 'codex2-real-running-stop-and-late-node-return');
  const start = requests.length;
  faults.set('jobs.get', { replyDelay: 6000 });
  await click(button(workspace, '刷新配图'));
  await until(() => requests.slice(start).some(r => r.method === 'jobs.get' && r.source === 'renderer' && r.received && !r.finished), 'c2 old workspace reply held');
  const slow = requests.slice(start).find(r => r.method === 'jobs.get' && r.source === 'renderer' && r.received && !r.finished);
  faults.delete('jobs.get');
  const queuedAt = Date.now();
  const queued = await rpc('test.consumer.enqueue', { account_id: fixture.account_a });
  check('c2_task_starts_queued', queued.kind === 'production' && queued.state === 'queued' && queued.attempt === 0);
  let running;
  await until(async () => {
    running = await rpc('test.consumer.snapshot', {});
    return running.node && running.task.state === 'running' && running.job?.state === 'running';
  }, 'c2 real consumer enters running node', 12000);
  report.c2 = { boundary: 'real production consumer; bounded wait before original demo topic node; jobs.stop is a real service write; running job differs from open completed article', queuedAt, queued, running, before, slow };
  check('c2_actual_running_task_and_engine', running.task.lease_token && running.job.lease && running.task.attempt === 1
    && running.events.length === 1 && running.events[0].claimed_state === 'running'
    && running.events[0].thread === 'ice-queue-consumer' && !running.events[0].finished
    && running.node.state === 'running' && running.node.leased && !running.node.finished
    && running.node.job_id === running.job_id && running.node.account_id === fixture.account_a
    && running.spec.demo === true && running.spec.approve_local_exec === false && !running.approval);
  // Observe the actual persisted state immediately before stop, not fixture names.
  const beforeStop = await rpc('jobs.get', { account_id: fixture.account_a, job_id: running.job_id });
  check('c2_stop_precondition_readable_running', beforeStop.job.state === 'running' && Boolean(beforeStop.job.lease));
  report.c2.runningIdentity = identity(beforeStop);
  await expectRemoval(e, 'harness-jobs-stop-no-navigation', '[]');
  const stopStart = requests.length;
  const stopped = await rpc('jobs.stop', { account_id: fixture.account_a, job_id: running.job_id });
  await finishAction(e);
  const write = requests.slice(stopStart).find(r => r.method === 'jobs.stop');
  const pausedWhileExecuting = await rpc('test.consumer.snapshot', {});
  report.c2.stop = { write, result: stopped, readableAt: Date.now(), snapshot: pausedWhileExecuting };
  check('c2_stop_committed_inside_old_reply_window', !slow.finished && slow.received < write.started && !write.failed
    && stopped.state === 'paused' && stopped.stopping && pausedWhileExecuting.job.state === 'paused'
    && pausedWhileExecuting.job.lease && pausedWhileExecuting.task.state === 'running' && !pausedWhileExecuting.node.finished);
  await rpc('test.consumer.release', {});
  let final;
  await until(async () => {
    final = await rpc('test.consumer.snapshot', {});
    return final.task.state === 'paused' && final.events[0]?.finished;
  }, 'c2 cooperative worker finishes paused', 12000);
  report.c2.final = final;
  check('c2_late_original_node_does_not_revive_job', final.job.state === 'paused' && !final.job.lease
    && final.task.lease_token === null && final.task.attempt === 1 && final.events.length === 1
    && final.events[0].outcome.status === 'paused' && final.node.released >= write.finished
    && final.node.finished >= final.node.released && !final.approval);
  await until(() => Boolean(slow.finished), 'c2 stale detail delivered after worker stopped');
  await until(() => requests.some(r => r.source === 'renderer' && r.method === 'jobs.list' && r.started >= write.finished
    && r.finished && r.jobs?.some(j => j.job_id === running.job_id && j.state === 'paused')), 'c2 renderer poll sees stopped consumer job', 30000);
  await ui(`document.querySelector('[data-job-id="${running.job_id}"] .ice-badge')?.textContent==='已暂停'`);
  const afterPoll = await rpc('test.consumer.snapshot', {});
  report.c2.afterPoll = afterPoll;
  check('c2_renderer_shows_real_consumer_paused', afterPoll.task.state === 'paused' && afterPoll.job.state === 'paused'
    && afterPoll.task.attempt === 1 && afterPoll.events.length === 1 && !afterPoll.task.lease_token && !afterPoll.job.lease);
  const freshStart = requests.length;
  await click(button(workspace, '刷新配图'));
  await until(() => requests.slice(freshStart).some(r => r.source === 'renderer' && r.method === 'jobs.get'
    && r.params.job_id === fixture.jobs.completed && r.finished && !r.failed), 'c2 renderer workspace refresh after stop');
  report.c2.fresh = requests.slice(freshStart).find(r => r.source === 'renderer' && r.method === 'jobs.get' && r.params.job_id === fixture.jobs.completed);
  await e('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const after = identity(await rpc('jobs.get', params));
  report.c2.after = after;
  check('c2_open_article_identity_and_plan_retained', JSON.stringify(before) === JSON.stringify(after));
  check('c2_workspace_nodes_and_focus_retained', await e(`window.__c2Tabs===document.querySelector('.ice-asset-tabs')&&window.__c2Editor===document.querySelector('.ice-editor')&&window.__c2Dialog===(${workspace})&&window.__c2Tabs.isConnected&&(${workspace}).contains(document.activeElement)`));
  const trace = await stopTrace(e);
  trace.removalAudit = auditRemovals(trace, ['tabs', 'dialog', 'editor']);
  report.d6.push(trace);
  check('c2_stop_has_no_unexpected_removal', trace.samples.length > 10 && trace.actions.length === 1
    && !trace.removalAudit.unexpected.length && !trace.removalAudit.missingOrRepeated.length);

  // Failure evidence first: budgets.get was faulted before the workspace mounted.
  // A failed initial read needs an explicit retry without discarding prompt edits.
  const prompt = `(${workspace}).querySelector('section[aria-label="生图提示词"]')`;
  await until(() => requests.some(r => r.method === 'budgets.get' && r.source === 'renderer' && r.failed), 'c2 budget read actually failed');
  await ui(`Boolean(${prompt})`);
  await e(`(()=>{const n=(${prompt}).querySelector('textarea[aria-label="当前图位生图提示词"]');window.__c2Prompt=n;window.__c2Text=n.value+${JSON.stringify('\n本轮保留的提示词修改')};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,window.__c2Text);n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  report.c2.budgetFailure = await e(`(${prompt}).innerText`);
  const hasRetry = await e(`Boolean(${button(prompt, '重新读取预算')})`);
  check('c2_failed_budget_read_is_visible_and_retryable', hasRetry && await e(`Boolean((${prompt}).querySelector('[role="alert"]'))&&(${prompt}).textContent.includes('本篇预算读取失败')`));
  faults.delete('budgets.get');
  if (hasRetry) {
    const retryStart = requests.length;
    await click(button(prompt, '重新读取预算'));
    await until(() => requests.slice(retryStart).some(r => r.source === 'renderer' && r.method === 'budgets.get' && r.finished && !r.failed), 'c2 real budget retry');
    await ui(`!(${prompt}).textContent.includes('预算未读取')&&!(${prompt}).querySelector('[role="alert"]')`);
  }
  check('c2_budget_retry_recovers_without_losing_edits', hasRetry && await e(`window.__c2Prompt===(${prompt}).querySelector('textarea[aria-label="当前图位生图提示词"]')&&window.__c2Prompt.value===window.__c2Text&&Boolean(${button(prompt, '调整本篇预算')})&&document.querySelector('.ice-asset-tabs')===window.__c2Tabs`));
  // Leave this isolated fixture cleanly; do not save the modified prompt.
  await click(button(prompt, '放弃修改'));
  check('c2_no_model_approval_or_prompt_writes', !requests.some(r => /^(prompts\.(generate|save)|budgets\.save|chat\.send|approvals\.decide|execution\.approve|jobs\.resume)$/.test(r.method)));
};
