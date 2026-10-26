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
            "SELECT content_hash, base_revision FROM editor_drafts WHERE account_id=? AND article_id=?",
            (account_id, article_id)).fetchone()
        if row and row["content_hash"] == content_hash and row["base_revision"] == base_revision:
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
        data["base_document"] = json.loads(data.pop("base_document_json"))
        if data.get("outcome"):
            data["outcome"] = json.loads(data["outcome"])
        result.append(data)
    return result


def finish_edit_proposal(store, proposal_id: str, status: str, outcome: dict[str, Any]) -> None:
    with store.transaction():
        store.conn.execute(
            "UPDATE edit_proposals SET status=?, outcome=?, decided_at=? WHERE proposal_id=?",
            (status, json.dumps(outcome, ensure_ascii=False), now_iso(), proposal_id))
        store.conn.execute("DELETE FROM proposal_decision_drafts WHERE proposal_id=?", (proposal_id,))



def list_edit_proposal_page(store, account_id: str, article_id: str, *, limit: int = 20,
                            cursor: str | None = None) -> dict[str, Any]:
    """Bounded metadata-only page; never select or decode document/operation JSON."""
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("每页提案数量必须为1到50的整数")
    anchor = None
    if cursor is not None:
        if not isinstance(cursor, str) or not cursor or len(cursor) > 200:
            raise ValueError("无效的提案翻页位置")
        anchor = store.conn.execute(
            "SELECT created_at, proposal_id FROM edit_proposals"
            " WHERE account_id=? AND article_id=? AND proposal_id=?",
            (account_id, article_id, cursor)).fetchone()
        if anchor is None:
            raise ValueError("无效的提案翻页位置")
    if anchor is None:
        rows = store.conn.execute(
            "SELECT proposal_id, base_revision, reason, status, created_at FROM edit_proposals"
            " WHERE account_id=? AND article_id=? AND status='pending'"
            " ORDER BY created_at DESC, proposal_id DESC LIMIT ?",
            (account_id, article_id, limit + 1)).fetchall()
    else:
        rows = store.conn.execute(
            "SELECT proposal_id, base_revision, reason, status, created_at FROM edit_proposals"
            " WHERE account_id=? AND article_id=? AND status='pending'"
            " AND (created_at<? OR (created_at=? AND proposal_id<?))"
            " ORDER BY created_at DESC, proposal_id DESC LIMIT ?",
            (account_id, article_id, anchor['created_at'], anchor['created_at'], cursor, limit + 1)).fetchall()
    items = [dict(row) for row in rows[:limit]]
    return {"proposals": items, "next_cursor": items[-1]['proposal_id'] if len(rows) > limit else None}


def get_article_edit_proposal(store, account_id: str, article_id: str, proposal_id: str) -> dict[str, Any]:
    row = store.conn.execute(
        "SELECT * FROM edit_proposals WHERE account_id=? AND article_id=? AND proposal_id=?",
        (account_id, article_id, proposal_id)).fetchone()
    if row is None:
        raise ValueError("提案不存在或不属于当前文章")
    data = dict(row)
    data["ops"] = json.loads(data.pop("ops_json"))
    data["base_document"] = json.loads(data.pop("base_document_json"))
    if data.get("outcome"):
        data["outcome"] = json.loads(data["outcome"])
    return data


def validate_proposal_decisions(decisions: Any, count: int, *, complete: bool = False) -> list[dict]:
    """Drafts may contain unfinished text; submissions must be complete and nonblank."""
    if not isinstance(decisions, list) or len(decisions) > count or (complete and len(decisions) != count):
        raise ValueError("审阅决定数量不符")
    seen = set()
    result = []
    for item in decisions:
        if not isinstance(item, dict):
            raise ValueError("无效的审阅决定")
        index, kind = item.get("op_index"), item.get("decision")
        if type(index) is not int or not 0 <= index < count or index in seen:
            raise ValueError("审阅决定序号必须唯一且在修改项范围内")
        if kind not in ("accept", "reject", "new_text"):
            raise ValueError("决定必须是 accept/reject/new_text")
        decision = {"op_index": index, "decision": kind}
        if kind == "new_text":
            text = item.get("text")
            if not isinstance(text, str) or len(text) > 20000 or (complete and not text.strip()):
                raise ValueError("改后接受的文本必须有效且不能超过20000字符")
            decision["text"] = text
        result.append(decision)
        seen.add(index)
    return sorted(result, key=lambda item: item["op_index"])


def get_proposal_decision_draft(store, account_id: str, article_id: str, proposal_id: str) -> dict | None:
    row = store.conn.execute(
        "SELECT d.* FROM proposal_decision_drafts d JOIN edit_proposals p ON p.proposal_id=d.proposal_id"
        " AND p.account_id=d.account_id AND p.article_id=d.article_id AND p.base_hash=d.base_hash"
        " WHERE d.account_id=? AND d.article_id=? AND d.proposal_id=? AND p.status='pending'",
        (account_id, article_id, proposal_id)).fetchone()
    if not row:
        return None
    data = dict(row)
    data["decisions"] = json.loads(data.pop("decisions_json"))
    return data


def save_proposal_decision_draft(store, account_id: str, article_id: str, proposal_id: str,
                                 base_hash: str, decisions: Any, expected_version: Any) -> dict:
    if type(expected_version) is not int or expected_version < 0:
        raise ValueError("审阅草稿版本无效")
    with store.transaction():
        proposal = get_article_edit_proposal(store, account_id, article_id, proposal_id)
        if proposal["status"] != "pending" or base_hash != proposal["base_hash"]:
            raise ValueError("提案已处理或基线已变化，请重新读取；当前输入不会被覆盖")
        items = validate_proposal_decisions(decisions, len(proposal["ops"]))
        encoded = json.dumps(items, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        existing = get_proposal_decision_draft(store, account_id, article_id, proposal_id)
        # Retrying an acknowledged-but-lost response is a no-op even with the old version.
        if existing and existing["decisions"] == items:
            return existing
        version = existing["version"] if existing else 0
        if version != expected_version:
            raise ValueError("审阅草稿已被其他窗口修改，请保留当前输入并重新打开核对，禁止覆盖")
        store.conn.execute(
            "INSERT INTO proposal_decision_drafts (account_id,article_id,proposal_id,base_hash,decisions_json,version,updated_at)"
            " VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,article_id,proposal_id) DO UPDATE SET"
            " decisions_json=excluded.decisions_json,version=excluded.version,updated_at=excluded.updated_at",
            (account_id, article_id, proposal_id, base_hash, encoded, version + 1, now_iso()))
        return get_proposal_decision_draft(store, account_id, article_id, proposal_id)
