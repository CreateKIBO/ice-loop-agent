'use strict';
module.exports = Object.freeze([
  'agent.runs_list', 'agent.tool_calls_list',
  'articles.document', 'articles.approval_status',
  'articles.editor_draft_get', 'articles.editor_draft_save', 'articles.editor_draft_clear',
  'articles.proposals_list', 'articles.proposal_decide',
  'articles.proposals_page', 'articles.proposal_get', 'articles.proposal_draft_save',
  'events.poll', 'knowledge.import', 'knowledge.search', 'workflow.graph',
  'downloads.stage', 'downloads.bind', 'downloads.list', 'assets.capture_status',
  // R05/R06/R13：目录选择器批准 + 后端统一就绪校验完成后再开放。
  'articles.export_bundle',
  // 批次 B：交付审阅快照只读；确认需带快照摘要，内容变化即拒绝。
  'articles.delivery_snapshot', 'articles.delivery_confirm',
  'chat.receipt', 'chat.cancel_send',
  'recovery.list', 'recovery.create',
  'backup.queue', 'backup.resume_queue',
  'models.limits_save', 'models.window_refresh',
  'skills.get', 'skills.save',
  // v3 普通文章 / 收藏 / 人工发布登记（documents.copy_payload、delivery_record、image_import 只供主进程，不在此列）
  'documents.list', 'documents.create', 'documents.get', 'documents.save_working', 'documents.commit_version',
  'documents.versions', 'documents.version', 'documents.restore', 'documents.update_meta', 'documents.trash',
  'documents.untrash', 'documents.duplicate', 'documents.markdown', 'documents.open_legacy',
  'documents.convert_paste', 'documents.import_paste', 'documents.import_original', 'documents.reconvert',
  'documents.image_import_data', 'documents.image_view', 'documents.images_library',
  'documents.render_delivery', 'documents.export_bundle', 'documents.from_candidate', 'documents.ai_draft_start',
  'publications.register', 'publications.list', 'publications.withdraw',
  'bookmarks.list', 'bookmarks.save', 'bookmarks.remove', 'bookmarks.reorder', 'bookmarks.restore_defaults',
]);
