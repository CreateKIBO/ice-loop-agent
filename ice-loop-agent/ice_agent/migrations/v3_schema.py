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
