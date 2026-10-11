"""编辑器存储扩展（M3-04/05/06/07/08）：工作草稿、文档缓存、修改提案。

与 domain/store.py 同一约定：每条 SQL 都是字符串字面量，值一律 ? 参数绑定；
写事务经 store.transaction() 与其他写路径串行，不另开连接模型。
"""
from __future__ import annotations

import json
from typing import Any

from ..domain.types import new_id, now_iso


# ------------------------------------------------------- 工作草稿（M3-04）
def save_editor_draft(store, account_id: str, article_id: str, content: str,
                      base_revision: str | None, content_hash: str) -> bool:
    """幂等保存：同 hash 重复保存不更新（rapid save 不产生重复版本噪音）。

    返回是否真正写入了新内容。
    """
    with store.transaction():
        row = store.conn.execute(
            "SELECT content_hash FROM editor_drafts WHERE account_id=? AND article_id=?",
            (account_id, article_id)).fetchone()
        if row and row["content_hash"] == content_hash:
            return False
        store.conn.execute(
            "INSERT INTO editor_drafts (account_id, article_id, content, base_revision,"
            " content_hash, updated_at) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(account_id, article_id) DO UPDATE SET"
            " content=excluded.content, base_revision=excluded.base_revision,"
            " content_hash=excluded.content_hash, updated_at=excluded.updated_at",
            (account_id, article_id, content, base_revision, content_hash, now_iso()))
        return True


def get_editor_draft(store, account_id: str, article_id: str) -> dict[str, Any] | None:
    row = store.conn.execute(
        "SELECT * FROM editor_drafts WHERE account_id=? AND article_id=?",
        (account_id, article_id)).fetchone()
    return dict(row) if row else None


def clear_editor_draft(store, account_id: str, article_id: str) -> None:
    store.conn.execute("DELETE FROM editor_drafts WHERE account_id=? AND article_id=?",
                       (account_id, article_id))
    store.conn.commit()


# ------------------------------------------------------- 文档派生缓存（M3-01）
def save_article_document(store, article_id: str, revision_id: str,
                          document: dict[str, Any], markdown_hash: str) -> None:
    store.conn.execute(
        "INSERT INTO article_documents (article_id, revision_id, schema_version,"
        " document_json, markdown_hash, created_at) VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(article_id, revision_id) DO UPDATE SET"
        " document_json=excluded.document_json, markdown_hash=excluded.markdown_hash",
        (article_id, revision_id, document.get("schema_version", 1),
         json.dumps(document, ensure_ascii=False), markdown_hash, now_iso()))
    store.conn.commit()


def get_article_document(store, article_id: str, revision_id: str) -> dict[str, Any] | None:
    row = store.conn.execute(
        "SELECT * FROM article_documents WHERE article_id=? AND revision_id=?",
        (article_id, revision_id)).fetchone()
    if not row:
        return None
    return {"document": json.loads(row["document_json"]),
            "markdown_hash": row["markdown_hash"],
            "schema_version": row["schema_version"]}


# ------------------------------------------------------- 修改提案（M3-05/06/07）
def create_edit_proposal(store, account_id: str, article_id: str, base_revision: str,
                         base_hash: str, base_document: dict[str, Any],
                         ops: list[dict[str, Any]], reason: str,
                         source_turn: str | None) -> dict[str, Any]:
    proposal_id = new_id("proposal")
    with store.transaction():
        store.conn.execute(
            "INSERT INTO edit_proposals (proposal_id, account_id, article_id,"
            " base_revision, base_hash, base_document_json, ops_json, reason, source_turn,"
            " status, created_at) VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)",
            (proposal_id, account_id, article_id, base_revision, base_hash,
             json.dumps(base_document, ensure_ascii=False),
             json.dumps(ops, ensure_ascii=False), reason or "", source_turn, now_iso()))
    return get_edit_proposal(store, proposal_id)


def get_edit_proposal(store, proposal_id: str) -> dict[str, Any]:
    row = store.conn.execute(
        "SELECT * FROM edit_proposals WHERE proposal_id=?", (proposal_id,)).fetchone()
    if not row:
        raise ValueError("提案不存在")
    data = dict(row)
    data["ops"] = json.loads(data.pop("ops_json"))
    data["base_document"] = json.loads(data.pop("base_document_json"))
    return data


def list_edit_proposals(store, account_id: str, article_id: str,
                        *, include_decided: bool = False) -> list[dict[str, Any]]:
    if include_decided:
        rows = store.conn.execute(
            "SELECT * FROM edit_proposals WHERE account_id=? AND article_id=?"
            " ORDER BY created_at DESC", (account_id, article_id)).fetchall()
    else:
        rows = store.conn.execute(
            "SELECT * FROM edit_proposals WHERE account_id=? AND article_id=?"
            " AND status='pending' ORDER BY created_at DESC",
            (account_id, article_id)).fetchall()
    result = []
    for row in rows:
        data = dict(row)
        data["ops"] = json.loads(data.pop("ops_json"))
        if data.get("outcome"):
            data["outcome"] = json.loads(data["outcome"])
        result.append(data)
    return result


def finish_edit_proposal(store, proposal_id: str, status: str, outcome: dict[str, Any]) -> None:
    store.conn.execute(
        "UPDATE edit_proposals SET status=?, outcome=?, decided_at=? WHERE proposal_id=?",
        (status, json.dumps(outcome, ensure_ascii=False), now_iso(), proposal_id))
    store.conn.commit()
