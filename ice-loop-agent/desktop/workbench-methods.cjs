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
  // v3.15 技能版本历史、预装内容、导出与导入解析（解析不写入，加入后随保存生效）
  'skills.versions', 'skills.version', 'skills.defaults', 'skills.export', 'skills.import_parse',
  // v3.16 技能组合与作用域：解析预览（本篇 → 系列 → 公众号）
  'skills.resolve',
  // v3 普通文章 / 收藏 / 人工发布登记（documents.copy_payload、delivery_record、image_import 只供主进程，不在此列）
  'documents.list', 'documents.create', 'documents.get', 'documents.save_working', 'documents.commit_version',
  'documents.versions', 'documents.version', 'documents.restore', 'documents.update_meta', 'documents.trash',
  'documents.untrash', 'documents.delete_forever', 'documents.skill_binding', 'documents.duplicate', 'documents.markdown', 'documents.open_legacy',
  'documents.convert_paste', 'documents.import_paste', 'documents.import_original', 'documents.reconvert',
  'documents.image_import_data', 'documents.image_view', 'documents.images_library',
  'documents.image_edit', 'documents.image_source_update', 'documents.import_docx',
  // P2 运营增强：批量整理、发布日历、建议管理、素材标签
  'documents.batch', 'documents.plan', 'documents.calendar', 'documents.suggestions', 'documents.suggestions_dismiss',
  'documents.library', 'documents.image_tags',
  // v3.12 微信兼容测试稿与逐项记录
  'documents.compat_create', 'documents.compat_get', 'documents.compat_record', 'documents.compat_report',
  'documents.perf_sample',
  // v3.13 作者试用记录（本地、手动开启，不含正文）
  'documents.trial_start', 'documents.trial_stop', 'documents.trial_note', 'documents.trial_status', 'documents.trial_report',
  'documents.render_delivery', 'documents.export_bundle', 'documents.from_candidate', 'documents.ai_draft_start',
  'documents.ai_guided_start', 'documents.variants',
  // v3 P1-01 文章内助手提案链：只产出提案，采纳在服务端按块校验后落为新版本。
  'documents.assist_start', 'documents.assist_list', 'documents.assist_get', 'documents.assist_cancel',
  'documents.assist_apply', 'documents.assist_dismiss', 'documents.assist_revert', 'documents.assist_search',
  'publications.register', 'publications.list', 'publications.withdraw',
  'bookmarks.list', 'bookmarks.save', 'bookmarks.remove', 'bookmarks.reorder', 'bookmarks.restore_defaults',
]);
