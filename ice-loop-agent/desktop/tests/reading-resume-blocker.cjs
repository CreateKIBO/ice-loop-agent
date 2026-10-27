'use strict';
const assert = require('node:assert/strict');
const { startTrace, expectRemoval, finishAction, stopTrace, auditRemovals } = require('./lifecycle-trace.cjs');

// Bounded evidence for the existing completed-article recovery blocker, not a
// consumer recovery. Only the owned completed fixture may receive this RPC.
module.exports = async function resumeBlocker({ e, ui, click, check, until, rpc, requests, fixture, report }) {
  const params = { account_id: fixture.account_a, job_id: fixture.jobs.completed };
  const identity = detail => ({ job: detail.job.job_id, article: detail.article.article_id,
    account: detail.article.spec.account_id, state: detail.job.state, node: detail.job.current_node,
    lease: detail.job.lease, stopping: detail.job.stopping, updated_at: detail.job.updated_at,
    body_hash: detail.body_hash, slots: detail.slots.map(s => [s.slot_id, s.content_hash, s.valid]),
    pending: detail.pending_approval, events: detail.events, invocations: detail.invocations });
  const before = identity(await rpc('jobs.get', params));
  const paused = await rpc('jobs.get', { account_id: fixture.account_a, job_id: fixture.jobs.paused });
  const safe = report.consumerEnabled === false && before.job === params.job_id
    && before.account === params.account_id && before.state === 'completed' && !before.lease
    && !before.stopping && before.article && before.slots.length > 0
    && paused.job.job_id === fixture.jobs.paused && paused.job.state === 'paused'
    && paused.article.spec.account_id === params.account_id;
  check('c3_resume_blocker_has_real_fixture_preconditions', Boolean(safe));
  assert(safe, 'Refuse resume probe outside the completed, unleased, owned fixture');
  const entries = await e(`(()=>{
    const complete=document.querySelector('[data-job-id="${fixture.jobs.completed}"]');
    const paused=document.querySelector('[data-job-id="${fixture.jobs.paused}"]');
    const edits=n=>n?[...n.querySelectorAll('button')].filter(b=>b.textContent.trim()==='编辑正文'):[];
    return {complete:!!complete?.isConnected,paused:!!paused?.isConnected,
      completeBadge:complete?.querySelector('.ice-badge')?.textContent,
      pausedBadge:paused?.querySelector('.ice-badge')?.textContent,
      completeEdit:edits(complete).length,pausedEdit:edits(paused).length};
  })()`);
  check('c3_existing_editor_entries_require_completed', entries.complete && entries.paused
    && entries.completeBadge === '已完成' && entries.pausedBadge === '已暂停'
    && entries.completeEdit === 1 && entries.pausedEdit === 0);
  await e(`void(window.__resumeBlockerNodes={tabs:document.querySelector('.ice-asset-tabs'),editor:document.querySelector('.ice-editor'),dialog:document.querySelector('.ice-asset-tabs')?.closest('[role="dialog"]'),focus:document.activeElement})`);
  await startTrace(e, 'completed-same-article-resume-rejected');
  // Tie the already-open workspace to the same job/article via an actual
  // renderer refresh, rather than inferring its identity from harness reads.
  const refreshStart = requests.length;
  await click(`[...window.__resumeBlockerNodes.dialog.querySelectorAll('button')].find(n=>n.textContent.trim()==='刷新配图'&&!n.disabled)`);
  await until(() => requests.slice(refreshStart).some(r => r.method === 'jobs.get' && r.source === 'renderer'
    && r.params.job_id === params.job_id && r.finished && !r.failed), 'same open workspace renderer detail refresh');
  const refresh = requests.slice(refreshStart).find(r => r.method === 'jobs.get' && r.source === 'renderer'
    && r.params.job_id === params.job_id && r.finished && !r.failed);
  await ui(`Boolean(window.__resumeBlockerNodes.tabs?.isConnected)&&!window.__resumeBlockerNodes.dialog.textContent.includes('图位读取失败')`);
  check('c3_open_workspace_renderer_refresh_matches_same_article', refresh.identity?.job === before.job
    && refresh.identity.article === before.article && refresh.identity.account === before.account
    && refresh.identity.body_hash === before.body_hash
    && JSON.stringify(refresh.identity.slots) === JSON.stringify(before.slots.map(s => s[0])));
  await expectRemoval(e, 'harness-completed-resume-no-navigation', '[]');
  const start = requests.length;
  let rejection;
  try { await rpc('jobs.resume', params); } catch (error) { rejection = error.message; }
  const after = identity(await rpc('jobs.get', params));
  const postRenderAt = await e('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(Date.now()))))');
  await until(() => e(`window.__d6.samples.some(s=>s.at>${postRenderAt})`), 'resume blocker observer captures sample after reply and render', 2000);
  await finishAction(e);
  const trace = await stopTrace(e);
  trace.removalAudit = auditRemovals(trace, ['tabs', 'dialog', 'editor']);
  report.d6.push(trace);
  const writes = requests.slice(start).filter(r => r.method === 'jobs.resume');
  const write = writes[0];
  report.c3.recoveryBlocker = { before, paused: identity(paused), entries, refresh, rejection, after, write,
    postRenderAt, firstPostRenderSampleAt: trace.samples.find(s => s.at > postRenderAt)?.at };
  check('c3_resume_rejection_received_from_real_service', writes.length === 1 && write.source === 'harness'
    && write.failed && !write.injected && write.params.job_id === params.job_id
    && write.dispatched >= write.started && write.received >= write.dispatched && write.finished >= write.received);
  check('c3_completed_article_resume_rejected_without_plan_change', rejection === '该任务不能继续'
    && JSON.stringify(before) === JSON.stringify(after));
  check('c3_resume_rejection_preserves_nodes_without_removals', trace.samples.some(s => s.at > postRenderAt) && trace.actions.length === 1
    && !trace.removalAudit.unexpected.length && !trace.removalAudit.missingOrRepeated.length
    && await e(`(()=>{const n=window.__resumeBlockerNodes;return n.tabs?.isConnected&&n.editor?.isConnected&&n.dialog?.isConnected&&n.tabs===document.querySelector('.ice-asset-tabs')&&n.editor===document.querySelector('.ice-editor')&&n.dialog===n.tabs.closest('[role="dialog"]')&&n.focus===document.activeElement;})()`));
};
