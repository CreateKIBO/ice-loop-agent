"""v2.0 numbered migrations. Each entry appends to ice_agent.migrations registry."""
from __future__ import annotations

import sqlite3

from . import migration


@migration(10, "持久事件流表：stream_events 供 v2 协议游标回放")
def _stream_events(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS stream_events ("
        " stream_id TEXT NOT NULL,"
        " sequence INTEGER NOT NULL,"
        " event_id TEXT NOT NULL UNIQUE,"
        " account_id TEXT NOT NULL DEFAULT '',"
        " event_type TEXT NOT NULL,"
        " payload TEXT NOT NULL,"
        " created_at TEXT NOT NULL,"
        " PRIMARY KEY (stream_id, sequence))"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stream_events_account"
        " ON stream_events(account_id, created_at)"
    )


@migration(11, "持久任务队列表：tasks 供可靠队列/租约/取消/幂等（M1-06）")
def _task_queue(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tasks ("
        " task_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " kind TEXT NOT NULL,"
        " priority INTEGER NOT NULL DEFAULT 5,"
        " state TEXT NOT NULL DEFAULT 'queued',"
        " input_hash TEXT NOT NULL DEFAULT '',"
        " idempotency_key TEXT UNIQUE,"
        " payload TEXT NOT NULL DEFAULT '{}',"
        " result TEXT,"
        " error_code TEXT,"
        " attempt INTEGER NOT NULL DEFAULT 0,"
        " max_attempts INTEGER NOT NULL DEFAULT 3,"
        " lease_token TEXT,"
        " lease_expires_at TEXT,"
        " cancel_requested INTEGER NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_ready"
        " ON tasks(state, priority, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_account"
        " ON tasks(account_id, state, created_at)"
    )


@migration(12, "编辑器表：文档派生缓存、编辑工作草稿、修改提案（M3）")
def _editor_tables(conn: sqlite3.Connection) -> None:
    # 结构化文档是 Markdown 规范值的可版本化派生（ADR-005），可随时重建。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS article_documents ("
        " article_id TEXT NOT NULL,"
        " revision_id TEXT NOT NULL,"
        " schema_version INTEGER NOT NULL DEFAULT 1,"
        " document_json TEXT NOT NULL,"
        " markdown_hash TEXT NOT NULL,"
        " created_at TEXT NOT NULL,"
        " PRIMARY KEY (article_id, revision_id))"
    )
    # 编辑器工作草稿：与采纳后的 publication_drafts、用户导入原稿分开存。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS editor_drafts ("
        " account_id TEXT NOT NULL,"
        " article_id TEXT NOT NULL,"
        " content TEXT NOT NULL,"
        " base_revision TEXT,"
        " content_hash TEXT NOT NULL,"
        " updated_at TEXT NOT NULL,"
        " PRIMARY KEY (account_id, article_id))"
    )
    # 选段修改提案：逐项 ops、基线文档快照、逐项决定与冲突报告。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS edit_proposals ("
        " proposal_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " article_id TEXT NOT NULL,"
        " base_revision TEXT NOT NULL,"
        " base_hash TEXT NOT NULL,"
        " base_document_json TEXT NOT NULL,"
        " ops_json TEXT NOT NULL,"
        " reason TEXT NOT NULL DEFAULT '',"
        " source_turn TEXT,"
        " status TEXT NOT NULL DEFAULT 'pending',"
        " outcome TEXT,"
        " created_at TEXT NOT NULL,"
        " decided_at TEXT)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_edit_proposals_article"
        " ON edit_proposals(account_id, article_id, created_at)"
    )


@migration(13, "知识检索表：来源、分块、元信息与FTS5索引（M4）")
def _knowledge_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_sources ("
        " source_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " display_name TEXT NOT NULL,"
        " source_path TEXT NOT NULL DEFAULT '',"
        " file_sha256 TEXT NOT NULL,"
        " parser TEXT NOT NULL,"
        " origin TEXT NOT NULL DEFAULT 'import',"
        " article_id TEXT,"
        " revision_id TEXT,"
        " indexed_at TEXT,"
        " created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_dedupe"
        " ON knowledge_sources(account_id, file_sha256)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_chunks ("
        " chunk_id TEXT PRIMARY KEY,"
        " source_id TEXT NOT NULL,"
        " account_id TEXT NOT NULL,"
        " section TEXT NOT NULL DEFAULT '',"
        " block_id TEXT,"
        " span_start INTEGER NOT NULL DEFAULT 0,"
        " span_end INTEGER NOT NULL DEFAULT 0,"
        " text TEXT NOT NULL,"
        " chunk_hash TEXT NOT NULL,"
        " ordinal INTEGER NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source"
        " ON knowledge_chunks(source_id, ordinal)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_account"
        " ON knowledge_chunks(account_id)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_meta ("
        " key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    # FTS5 运行时探测：不可用时整体走 LIKE 降级（ADR-006），迁移不能因缺模块失败。
    fts5_ok = True
    try:
        conn.execute("CREATE VIRTUAL TABLE temp.knowledge_fts5_probe USING fts5(x)")
        conn.execute("DROP TABLE temp.knowledge_fts5_probe")
    except sqlite3.Error:
        fts5_ok = False
    conn.execute("INSERT INTO knowledge_meta (key, value) VALUES ('fts5', ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 ("1" if fts5_ok else "0",))
    if fts5_ok:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5("
            " text, chunk_id UNINDEXED, account_id UNINDEXED, tokenize='trigram')"
        )


@migration(14, "Agent 运行与工具调用持久化、Brief、澄清问题（M5）")
def _agent_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_runs ("
        " run_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " conversation_id TEXT,"
        " trigger TEXT NOT NULL DEFAULT 'chat',"
        " status TEXT NOT NULL DEFAULT 'running',"
        " turn_count INTEGER NOT NULL DEFAULT 0,"
        " tool_call_count INTEGER NOT NULL DEFAULT 0,"
        " stop_reason TEXT,"
        " created_at TEXT NOT NULL,"
        " finished_at TEXT)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation"
        " ON agent_runs(account_id, conversation_id, created_at)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_tool_calls ("
        " call_id TEXT PRIMARY KEY,"
        " run_id TEXT NOT NULL,"
        " turn_id TEXT NOT NULL,"
        " tool_name TEXT NOT NULL,"
        " args_hash TEXT NOT NULL,"
        " args_json TEXT NOT NULL,"
        " status TEXT NOT NULL DEFAULT 'running',"
        " result_json TEXT,"
        " error_code TEXT,"
        " duration_ms INTEGER,"
        " created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run"
        " ON agent_tool_calls(run_id, created_at)"
    )
    # 同 run+tool+args_hash 的失败记录用于熔断（M5-03）。
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_breaker"
        " ON agent_tool_calls(tool_name, args_hash, status)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_briefs ("
        " brief_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " conversation_id TEXT NOT NULL,"
        " version INTEGER NOT NULL DEFAULT 1,"
        " brief_json TEXT NOT NULL,"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL,"
        " UNIQUE(account_id, conversation_id))"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_questions ("
        " question_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " conversation_id TEXT NOT NULL,"
        " turn_id TEXT,"
        " questions_json TEXT NOT NULL,"
        " status TEXT NOT NULL DEFAULT 'open',"
        " answers_json TEXT,"
        " created_at TEXT NOT NULL,"
        " answered_at TEXT)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_questions_conversation"
        " ON agent_questions(account_id, conversation_id, status)"
    )


@migration(15, "会话摘要表（M5-08）：确定性核心摘要与涵盖范围")
def _conversation_summaries(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS conversation_summaries ("
        " summary_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " conversation_id TEXT NOT NULL UNIQUE,"
        " covers_from TEXT NOT NULL DEFAULT '',"
        " covers_to TEXT NOT NULL DEFAULT '',"
        " digest_json TEXT NOT NULL,"
        " content_hash TEXT NOT NULL,"
        " created_at TEXT NOT NULL)"
    )


@migration(16, "视觉资产与模型预算归属（M7/M8）：StylePack、提示词候选、图位-Run 绑定、下载待归档、会话调用归属")
def _asset_budget_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS style_packs ("
        " pack_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " version INTEGER NOT NULL,"
        " pack_json TEXT NOT NULL,"
        " status TEXT NOT NULL DEFAULT 'draft',"
        " approved_at TEXT,"
        " created_at TEXT NOT NULL,"
        " UNIQUE(account_id, version))"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS prompt_revisions ("
        " revision_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " job_id TEXT NOT NULL,"
        " figure_no INTEGER NOT NULL,"
        " version INTEGER NOT NULL,"
        " origin TEXT NOT NULL DEFAULT 'agent',"
        " prompt_text TEXT NOT NULL,"
        " prompt_hash TEXT NOT NULL,"
        " lint_json TEXT,"
        " created_at TEXT NOT NULL,"
        " UNIQUE(account_id, job_id, figure_no, version))"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS slot_run_bindings ("
        " binding_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " job_id TEXT NOT NULL,"
        " figure_no INTEGER NOT NULL,"
        " run_id TEXT NOT NULL,"
        " source_hash TEXT NOT NULL,"
        " input_hash TEXT NOT NULL DEFAULT '',"
        " expected_result_kind TEXT NOT NULL DEFAULT 'success',"
        " approved_error INTEGER NOT NULL DEFAULT 0,"
        " bound_by TEXT NOT NULL DEFAULT 'user',"
        " created_at TEXT NOT NULL,"
        " UNIQUE(account_id, job_id, figure_no))"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS download_staging ("
        " download_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " file_path TEXT NOT NULL,"
        " file_sha256 TEXT NOT NULL,"
        " mime TEXT NOT NULL DEFAULT '',"
        " size INTEGER NOT NULL DEFAULT 0,"
        " origin_url TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL DEFAULT 'pending',"
        " bound_slot TEXT,"
        " created_at TEXT NOT NULL,"
        " decided_at TEXT)"
    )
    # M8-03（KI-002）：创作会话的模型调用归属与预算计数。
    conn.execute(
        "ALTER TABLE model_invocations ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_model_invocations_conversation"
        " ON model_invocations(conversation_id, status)"
    )


@migration(17, "任务幂等域修正（R07）：全局唯一键改为 (account,kind,key) 域；旧任务保留")
def _task_idempotency_domain(conn: sqlite3.Connection) -> None:
    # SQLite 无法去掉列上的 UNIQUE，按标准流程重建表；全部旧行原样迁移。
    conn.execute(
        "CREATE TABLE tasks_v17 ("
        " task_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " kind TEXT NOT NULL,"
        " priority INTEGER NOT NULL DEFAULT 5,"
        " state TEXT NOT NULL DEFAULT 'queued',"
        " input_hash TEXT NOT NULL DEFAULT '',"
        " idempotency_key TEXT,"
        " payload TEXT NOT NULL DEFAULT '{}',"
        " result TEXT,"
        " error_code TEXT,"
        " attempt INTEGER NOT NULL DEFAULT 0,"
        " max_attempts INTEGER NOT NULL DEFAULT 3,"
        " lease_token TEXT,"
        " lease_expires_at TEXT,"
        " cancel_requested INTEGER NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE UNIQUE INDEX idx_tasks_v17_idem ON tasks_v17(account_id, kind, idempotency_key)"
        " WHERE idempotency_key IS NOT NULL"
    )
    conn.execute(
        "INSERT INTO tasks_v17 (task_id, account_id, kind, priority, state, input_hash,"
        " idempotency_key, payload, result, error_code, attempt, max_attempts,"
        " lease_token, lease_expires_at, cancel_requested, created_at, updated_at)"
        " SELECT task_id, account_id, kind, priority, state, input_hash,"
        " idempotency_key, payload, result, error_code, attempt, max_attempts,"
        " lease_token, lease_expires_at, cancel_requested, created_at, updated_at"
        " FROM tasks"
    )
    conn.execute("DROP TABLE tasks")
    conn.execute("ALTER TABLE tasks_v17 RENAME TO tasks")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_ready"
        " ON tasks(state, priority, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_account"
        " ON tasks(account_id, state, created_at)"
    )


@migration(18, "任务-job绑定表（批次A）：queue task ↔ engine job 持久关联，重启/重排不重建")
def _task_job_bindings(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS task_job_bindings ("
        " task_id TEXT PRIMARY KEY,"
        " job_id TEXT NOT NULL UNIQUE,"
        " account_id TEXT NOT NULL,"
        " bound_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_job_bindings_account"
        " ON task_job_bindings(account_id)"
    )


@migration(19, "运行截图溯源（C2）：截图资源记录账户/任务/图位/运行/源码 hash，证据变化可判定失效")
def _capture_provenance(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS capture_assets ("
        " capture_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " job_id TEXT NOT NULL,"
        " figure_no INTEGER NOT NULL,"
        " candidate_id TEXT NOT NULL,"
        " resource_id TEXT NOT NULL,"
        " file_sha256 TEXT NOT NULL,"
        " capture_hash TEXT NOT NULL,"
        " run_ids TEXT NOT NULL,"
        " source_hashes TEXT NOT NULL,"
        " automatic INTEGER NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_capture_assets_slot"
        " ON capture_assets(account_id, job_id, figure_no)"
    )


@migration(20, "提案审阅决定草稿：独立保存、账号隔离及乐观并发校验")
def _proposal_decision_drafts(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE proposal_decision_drafts ("
        " account_id TEXT NOT NULL, article_id TEXT NOT NULL, proposal_id TEXT NOT NULL,"
        " base_hash TEXT NOT NULL, decisions_json TEXT NOT NULL,"
        " version INTEGER NOT NULL, updated_at TEXT NOT NULL,"
        " PRIMARY KEY(account_id, article_id, proposal_id))"
    )


@migration(21, "创作发送回执：账号/会话/请求幂等与消息原子受理")
def _creative_send_receipts(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE creative_send_receipts ("
        " account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,"
        " input_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted','cancelled')),"
        " message_id TEXT UNIQUE, user_message_id TEXT, created_at TEXT NOT NULL,"
        " PRIMARY KEY(account_id, conversation_id, request_id),"
        " CHECK((state='accepted' AND message_id IS NOT NULL AND user_message_id IS NOT NULL) OR"
        " (state='cancelled' AND message_id IS NULL AND user_message_id IS NULL)))"
    )


@migration(22, "写作技能设置：公众号隔离、版本与乐观并发保存")
def _writing_skills(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE writing_skill_settings ("
        " account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,"
        " settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
