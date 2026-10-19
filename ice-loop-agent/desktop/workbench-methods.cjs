'use strict';
module.exports = Object.freeze([
  'agent.runs_list', 'agent.tool_calls_list',
  'articles.document', 'articles.approval_status',
  'articles.editor_draft_get', 'articles.editor_draft_save', 'articles.editor_draft_clear',
  'articles.proposals_list', 'articles.proposal_decide',
  'events.poll', 'knowledge.import', 'knowledge.search', 'workflow.graph',
  'downloads.stage', 'downloads.bind', 'downloads.list', 'assets.capture_status',
  // R05/R06/R13：目录选择器批准 + 后端统一就绪校验完成后再开放。
  'articles.export_bundle',
  // 批次 B：交付审阅快照只读；确认需带快照摘要，内容变化即拒绝。
  'articles.delivery_snapshot', 'articles.delivery_confirm',
  'backup.queue', 'backup.resume_queue',
  'models.limits_save', 'models.window_refresh',
]);
