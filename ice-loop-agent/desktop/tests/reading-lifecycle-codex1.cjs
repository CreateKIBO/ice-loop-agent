'use strict';
const { startTrace, stopTrace, auditRemovals } = require('./lifecycle-trace.cjs');

// Runs after round3 in the same fresh, serial fixture. Only this scope enables
// the real service consumer. Its single demo task stops at topic approval.
module.exports = async function codex1({ e, ui, click, check, until, rpc, requests, faults, fixture, report }) {
  const workspace = `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent==='文章配图工作台')`;
  const button = (root, label) => `[...(${root}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)}&&!n.disabled)`;
  await e(`void(window.__consumerTabs=document.querySelector('.ice-asset-tabs'))`);
  await startTrace(e, 'codex1-production-consumer-during-slow-detail');
  const slowStart = requests.length;
  faults.set('jobs.get', { replyDelay: 6000 });
  await click(button(workspace, '刷新配图'));
  await until(() => requests.slice(slowStart).some(r => r.method === 'jobs.get' && r.received && !r.finished), 'consumer slow detail held');
  const slow = requests.slice(slowStart).find(r => r.method === 'jobs.get' && r.received && !r.finished);
  faults.delete('jobs.get');
  const queuedAt = Date.now();
  const queued = await rpc('test.consumer.enqueue', { account_id: fixture.account_a });
  check('consumer_initially_queued_production', queued.kind === 'production' && queued.state === 'queued' && queued.attempt === 0);
  let snapshot;
  await until(async () => {
    snapshot = await rpc('test.consumer.snapshot', {});
    return snapshot.task.state === 'waiting_user' && snapshot.events.some(event => event.finished);
  }, 'real consumer reaches first approval', 15000);
  report.consumer = { queuedAt, queued, snapshot, observedAt: Date.now(), slow };
  check('consumer_wrote_inside_held_reply', !slow.finished && slow.received <= queuedAt);
  check('consumer_actual_thread_once', snapshot.thread_alive && snapshot.events.length === 1
    && snapshot.events[0].thread === 'ice-queue-consumer' && snapshot.events[0].task_id === queued.task_id
    && snapshot.events[0].claimed_state === 'running' && snapshot.events[0].leased && snapshot.events[0].attempt === 1
    && snapshot.events[0].outcome.status === 'waiting_user' && snapshot.task.attempt === 1);
  check('consumer_strict_bound_approval', snapshot.job_id === snapshot.task.result.job_id
    && snapshot.job.state === 'awaiting_approval' && snapshot.approval?.scope === 'topic'
    && snapshot.spec.account_id === fixture.account_a && snapshot.spec.demo === true
    && snapshot.spec.approve_local_exec === false && snapshot.task.lease_token === null);
  await until(() => Boolean(slow.finished), 'consumer stale detail delivered');
  // A genuine renderer interval must see the consumer-created job before any navigation.
  await until(() => requests.some(r => r.source === 'renderer' && r.method === 'jobs.list'
    && r.started >= queuedAt && r.finished && r.jobs?.some(job => job.job_id === snapshot.job_id && job.state === 'awaiting_approval')), 'renderer poll sees consumer job', 30000);
  await ui(`document.querySelector('[data-job-id="${snapshot.job_id}"] .ice-badge')?.textContent==='等待审批'`);
  check('consumer_job_state_visible_in_task_list', true);
  const again = await rpc('test.consumer.snapshot', {});
  check('consumer_waiting_gate_not_reclaimed', again.task.attempt === 1 && again.events.length === 1 && again.job_id === snapshot.job_id);
  check('consumer_workspace_tabs_and_focus_retained', await e(`window.__consumerTabs===document.querySelector('.ice-asset-tabs')&&window.__consumerTabs.isConnected&&(${workspace}).contains(document.activeElement)`));
  const trace = await stopTrace(e);
  trace.removalAudit = auditRemovals(trace, ['tabs', 'dialog', 'editor']);
  report.d6.push(trace);
  check('consumer_no_unexpected_removals', trace.samples.length > 10 && !trace.removalAudit.unexpected.length && !trace.removalAudit.missingOrRepeated.length);

  // Regression: a failed initial resource read cannot claim that the library is empty.
  const picker = `[...(${workspace}).querySelectorAll('section')].find(n=>n.querySelector('h4')?.textContent==='复用当前公众号资源')`;
  const resourceStart = requests.length;
  faults.set('resources.list', { fail: true });
  await click(button(picker, '从资源库选图'));
  await until(() => requests.slice(resourceStart).some(r => r.method === 'resources.list' && r.failed), 'initial resource read actually fails');
  await ui(`(${picker}).textContent.includes('资源读取失败')`);
  report.resourceInitialFailure = await e(`(${picker}).innerText`);
  check('resource_failed_read_has_no_false_empty_or_count', await e(`!(${picker}).textContent.includes('没有匹配资源')&&!(${picker}).textContent.includes('共 0 张')&&!(${picker}).textContent.includes('1/1')`));
  faults.delete('resources.list');
  await click(button(picker, '重试'));
  await ui(`(${picker}).querySelectorAll('article').length>0&&!(${picker}).textContent.includes('资源读取失败')`);
  check('resource_retry_recovers_real_rows', true);
  const changeSearch = async value => e(`(()=>{const input=(${picker}).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await changeSearch('no-resource-codex1');
  await ui(`(${picker}).textContent.includes('没有匹配资源')`);
  check('resource_successful_search_has_honest_empty_state', await e(`(${picker}).textContent.includes('共 0 张')`));
  await changeSearch('');
  await ui(`(${picker}).querySelectorAll('article').length>0`);
  const search = await e(`(${picker}).querySelector('article strong').textContent`);
  report.resourceSearch = search;
  await changeSearch(search);
  await ui(`(${picker}).querySelectorAll('article').length>0`);
  await click(button(picker, '收起资源库'));
  faults.set('resources.list', { fail: true });
  const cachedStart = requests.length;
  await click(button(picker, '从资源库选图'));
  await until(() => requests.slice(cachedStart).some(r => r.method === 'resources.list' && r.failed), 'cached resource refresh actually fails');
  await ui(`(${picker}).textContent.includes('资源读取失败')`);
  check('resource_failed_refresh_retains_cached_rows_and_search', await e(`(${picker}).querySelectorAll('article').length>0&&(${picker}).querySelector('input').value===${JSON.stringify(search)}&&(${picker}).textContent.includes('已保留上次读取的资源')`));
  faults.delete('resources.list');
  await click(button(picker, '重试'));
  await ui(`!(${picker}).textContent.includes('资源读取失败')`);
  check('consumer_scope_no_model_or_approval_writes', !requests.some(r => /^(prompts\.generate|chat\.send|jobs\.resume|approvals\.decide|execution\.approve)$/.test(r.method)));
};
