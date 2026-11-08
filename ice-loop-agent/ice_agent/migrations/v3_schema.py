"""v3.0 迁移：普通文章（文档）子系统、收藏与人工发布登记（ADR-018）。

只新增表，不改写旧 articles/jobs/publication_drafts 正文；旧数据通过
documents.origin/origin_ref 映射按需接入统一索引。
"""
from __future__ import annotations

import sqlite3

from . import migration


@migration(23, "v3 普通文章：独立文档索引、工作副本、版本、导入原件、交付、收藏与人工发布登记")
def _documents(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE documents ("
        " document_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL,"
        " origin TEXT NOT NULL CHECK(origin IN ('blank','paste','import','ai','copy','legacy_draft','legacy_job')),"
        " origin_ref TEXT NOT NULL DEFAULT '',"
        " series TEXT, episode INTEGER,"
        " lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','trashed')),"
        " generation_state TEXT NOT NULL DEFAULT 'none' CHECK(generation_state IN ('none','running','ready','failed','cancelled')),"
        " meta_json TEXT NOT NULL DEFAULT '{}',"
        " head_version_id TEXT,"
        " created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT)"
    )
    # 同一旧来源只映射一次（防止重复/错归属）；普通新稿 origin_ref 为空不受约束。
    conn.execute(
        "CREATE UNIQUE INDEX idx_documents_origin ON documents(account_id, origin, origin_ref)"
        " WHERE origin_ref <> ''"
    )
    conn.execute("CREATE INDEX idx_documents_account ON documents(account_id, lifecycle, updated_at)")
    conn.execute(
        "CREATE TABLE document_working ("
        " document_id TEXT PRIMARY KEY REFERENCES documents(document_id),"
        " account_id TEXT NOT NULL, content_json TEXT NOT NULL, schema_version INTEGER NOT NULL,"
        " base_version_id TEXT, content_hash TEXT NOT NULL, revision INTEGER NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE document_versions ("
        " version_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(document_id),"
        " account_id TEXT NOT NULL, parent_version_id TEXT, content_json TEXT NOT NULL,"
        " schema_version INTEGER NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL,"
        " producer TEXT NOT NULL CHECK(producer IN ('user','autosave','checkpoint','restore','import','legacy','ai','delivery','convert')),"
        " note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX idx_document_versions ON document_versions(document_id, created_at)")
    conn.execute(
        "CREATE TABLE document_import_originals ("
        " import_id TEXT PRIMARY KEY, document_id TEXT, account_id TEXT NOT NULL,"
        " kind TEXT NOT NULL CHECK(kind IN ('html','text','markdown')),"
        " original TEXT NOT NULL, original_hash TEXT NOT NULL, report_json TEXT NOT NULL,"
        " created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE document_deliveries ("
        " delivery_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, account_id TEXT NOT NULL,"
        " version_id TEXT NOT NULL, delivery_hash TEXT NOT NULL,"
        " kind TEXT NOT NULL CHECK(kind IN ('copy_html','copy_text','export')),"
        " destination TEXT NOT NULL DEFAULT '', issues_json TEXT NOT NULL DEFAULT '[]',"
        " created_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX idx_document_deliveries ON document_deliveries(document_id, created_at)")
    conn.execute(
        "CREATE TABLE bookmarks ("
        " bookmark_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, url TEXT NOT NULL,"
        " title TEXT NOT NULL, position INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id, url))"
    )
    conn.execute(
        "CREATE TABLE bookmark_seeds (account_id TEXT PRIMARY KEY, seeded_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE publication_records ("
        " record_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, document_id TEXT NOT NULL,"
        " version_id TEXT NOT NULL, delivery_id TEXT, url TEXT NOT NULL DEFAULT '',"
        " published_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',"
        " source TEXT NOT NULL DEFAULT 'user_registered' CHECK(source IN ('user_registered')),"
        " state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','withdrawn')),"
        " registered_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX idx_publication_records ON publication_records(account_id, document_id)")


@migration(24, "v3 文章内助手：局部改写/扩写/压缩/改语气/图位建议的提案链")
def _document_proposals(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE document_proposals ("
        " proposal_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, document_id TEXT NOT NULL,"
        " base_revision INTEGER NOT NULL, base_content_hash TEXT NOT NULL,"
        " action TEXT NOT NULL CHECK(action IN ('rewrite','expand','compress','tone','image_slots','custom')),"
        " instruction TEXT NOT NULL DEFAULT '', target_block_ids TEXT NOT NULL DEFAULT '[]',"
        " context_json TEXT NOT NULL DEFAULT '{}', ops_json TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL CHECK(status IN ('generating','ready','failed','cancelled','applied','partially_applied','rejected')),"
        " error TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '', usage_json TEXT NOT NULL DEFAULT '{}',"
        " decision_json TEXT NOT NULL DEFAULT '{}', applied_version_id TEXT,"
        " created_at TEXT NOT NULL, finished_at TEXT, decided_at TEXT)"
    )
    conn.execute("CREATE INDEX idx_document_proposals ON document_proposals(account_id, document_id, created_at)")


@migration(25, "v3 作者试用记录：本地试用会话与关键步骤事件（需用户手动开启，不含正文）")
def _trial_records(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE trial_sessions ("
        " session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',"
        " include_titles INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, ended_at TEXT)"
    )
    conn.execute("CREATE INDEX idx_trial_sessions ON trial_sessions(account_id, started_at)")
    conn.execute(
        "CREATE TABLE trial_events ("
        " event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES trial_sessions(session_id),"
        " account_id TEXT NOT NULL, kind TEXT NOT NULL, document_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}',"
        " created_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX idx_trial_events ON trial_events(session_id, created_at)")


@migration(26, "v3.15 写作技能版本历史：每次保存改动留一版，可查看、导出、恢复；移除技能不删历史")
def _writing_skill_versions(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE writing_skill_versions ("
        " account_id TEXT NOT NULL, skill_id TEXT NOT NULL, version INTEGER NOT NULL,"
        " name TEXT NOT NULL, instructions TEXT NOT NULL, rules_json TEXT NOT NULL DEFAULT '{}',"
        " content_hash TEXT NOT NULL, source_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,"
        " PRIMARY KEY(account_id, skill_id, version))"
    )


@migration(27, "v3.17 会话技能：助手会话可选主技能与辅助技能，之后的回复按会话设置")
def _conversation_skill_bindings(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE conversation_skill_bindings ("
        " account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, binding_json TEXT NOT NULL, updated_at TEXT NOT NULL,"
        " PRIMARY KEY(account_id, conversation_id))"
    )


@migration(28, "v3.19 技能参考资料与示例：文件正文单独保存（不可变），技能与历史版本只记引用")
def _writing_skill_files(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE writing_skill_files ("
        " account_id TEXT NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,"
        " text TEXT NOT NULL, sha256 TEXT NOT NULL, chars INTEGER NOT NULL, created_at TEXT NOT NULL,"
        " PRIMARY KEY(account_id, file_id))"
    )
    conn.execute("ALTER TABLE writing_skill_versions ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'")


@migration(29, "v3.22 同步到公众号草稿箱：接口配置、远端素材映射、草稿同步记录与外部写入日志；交付记录增加 wechat_draft")
def _wechat_drafts(conn: sqlite3.Connection) -> None:
    # SQLite 不能修改 CHECK：重建交付记录表，原数据逐行保留。
    conn.execute(
        "CREATE TABLE document_deliveries_v29 ("
        " delivery_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, account_id TEXT NOT NULL,"
        " version_id TEXT NOT NULL, delivery_hash TEXT NOT NULL,"
        " kind TEXT NOT NULL CHECK(kind IN ('copy_html','copy_text','export','wechat_draft')),"
        " destination TEXT NOT NULL DEFAULT '', issues_json TEXT NOT NULL DEFAULT '[]',"
        " created_at TEXT NOT NULL)"
    )
    conn.execute("INSERT INTO document_deliveries_v29 SELECT delivery_id, document_id, account_id, version_id, delivery_hash,"
                 " kind, destination, issues_json, created_at FROM document_deliveries")
    conn.execute("DROP TABLE document_deliveries")
    conn.execute("ALTER TABLE document_deliveries_v29 RENAME TO document_deliveries")
    conn.execute("CREATE INDEX idx_document_deliveries ON document_deliveries(document_id, created_at)")
    conn.execute(
        "CREATE TABLE wechat_config ("
        " account_id TEXT PRIMARY KEY, appid TEXT NOT NULL, updated_at TEXT NOT NULL,"
        " last_check_at TEXT, last_check_ok INTEGER, last_check_message TEXT NOT NULL DEFAULT '')"
    )
    conn.execute(  # 本地图片 → 远端地址/素材。按公众号 + AppID 隔离，不跨账号复用远端 ID。
        "CREATE TABLE wechat_assets ("
        " account_id TEXT NOT NULL, appid TEXT NOT NULL, sha256 TEXT NOT NULL,"
        " kind TEXT NOT NULL CHECK(kind IN ('content','cover')),"
        " remote_url TEXT NOT NULL DEFAULT '', media_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,"
        " PRIMARY KEY(account_id, appid, sha256, kind))"
    )
    conn.execute(
        "CREATE TABLE wechat_drafts ("
        " account_id TEXT NOT NULL, document_id TEXT NOT NULL, appid TEXT NOT NULL, media_id TEXT NOT NULL,"
        " version_id TEXT NOT NULL, delivery_hash TEXT NOT NULL, remote_text_hash TEXT NOT NULL DEFAULT '',"
        " synced_at TEXT NOT NULL, PRIMARY KEY(account_id, document_id, appid))"
    )
    conn.execute(  # 每次外部写入先记日志：超时等“结果未知”时，下次先请用户核对后台，不盲目重复创建
        "CREATE TABLE wechat_operations ("
        " op_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, document_id TEXT, appid TEXT NOT NULL,"
        " action TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed','unknown')),"
        " detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, finished_at TEXT)"
    )
    conn.execute("CREATE INDEX idx_wechat_operations ON wechat_operations(account_id, document_id, created_at)")


@migration(30, "v3.24 多图文草稿：几篇文章按顺序合成一篇草稿，记录每个位置对应的文章、版本与后台正文指纹")
def _wechat_draft_groups(conn: sqlite3.Connection) -> None:
    conn.execute(  # group_key 由文章顺序决定：顺序或篇目变了就是另一篇多图文（接口不能增删、调序）
        "CREATE TABLE wechat_draft_groups ("
        " account_id TEXT NOT NULL, appid TEXT NOT NULL, group_key TEXT NOT NULL,"
        " document_ids_json TEXT NOT NULL, media_id TEXT NOT NULL, members_json TEXT NOT NULL,"
        " synced_at TEXT NOT NULL, PRIMARY KEY(account_id, appid, group_key))"
    )
