"""Agent 持久化（M5-01/03/07/08）：Brief、澄清问题的读写。

与 editorial/storage.py 同一约定：SQL 全部为字符串字面量，值一律 ? 绑定。
"""
from __future__ import annotations

import json
from typing import Any

from ..domain.types import new_id, now_iso


def get_brief(store, account_id: str, conversation_id: str) -> dict[str, Any] | None:
    row = store.conn.execute(
        "SELECT version, brief_json FROM agent_briefs WHERE account_id=? AND conversation_id=?",
        (account_id, conversation_id)).fetchone()
    if not row:
        return None
    data = json.loads(row["brief_json"])
    data["version"] = row["version"]
    return data


def upsert_brief(store, account_id: str, conversation_id: str,
                 merged: dict[str, Any], version: int) -> str:
    brief_id = merged["brief_id"]
    store.conn.execute(
        "INSERT INTO agent_briefs (brief_id, account_id, conversation_id, version,"
        " brief_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(account_id, conversation_id) DO UPDATE SET"
        " version=excluded.version, brief_json=excluded.brief_json, updated_at=excluded.updated_at",
        (brief_id, account_id, conversation_id, version,
         json.dumps(merged, ensure_ascii=False), now_iso(), now_iso()))
    store.conn.commit()
    return brief_id


def brief_version(store, account_id: str, conversation_id: str) -> int:
    row = store.conn.execute(
        "SELECT version FROM agent_briefs WHERE account_id=? AND conversation_id=?",
        (account_id, conversation_id)).fetchone()
    return row["version"] if row else 0


def insert_question(store, account_id: str, conversation_id: str, turn_id: str,
                    questions: list[dict[str, Any]], freeform: bool) -> str:
    question_id = new_id("q")
    store.conn.execute(
        "INSERT INTO agent_questions (question_id, account_id, conversation_id, turn_id,"
        " questions_json, status, created_at) VALUES (?,?,?,?,?, 'open', ?)",
        (question_id, account_id, conversation_id, turn_id,
         json.dumps({"questions": questions, "freeform": freeform}, ensure_ascii=False),
         now_iso()))
    store.conn.commit()
    return question_id


def answer_question(store, account_id: str, question_id: str,
                    answers: dict[str, str]) -> dict[str, Any]:
    row = store.conn.execute(
        "SELECT * FROM agent_questions WHERE question_id=? AND account_id=?",
        (question_id, account_id)).fetchone()
    if not row:
        raise ValueError("问题不存在或不属于当前公众号")
    if row["status"] != "open":
        data = json.loads(row["answers_json"] or "{}")
        data["answers"] = json.loads(row["answers_json"] or "{}").get("answers", {})
        return {"question_id": question_id, "status": row["status"], "answers": data.get("answers", {})}
    payload = json.loads(row["questions_json"])
    known = {q.get("id") for q in payload.get("questions", [])}
    filtered = {str(k): str(v)[:2000] for k, v in answers.items() if k in known}
    store.conn.execute(
        "UPDATE agent_questions SET status='answered', answers_json=?, answered_at=?"
        " WHERE question_id=?",
        (json.dumps({"answers": filtered}, ensure_ascii=False), now_iso(), question_id))
    store.conn.commit()
    return {"question_id": question_id, "status": "answered", "answers": filtered}


def open_questions(store, account_id: str, conversation_id: str) -> list[dict[str, Any]]:
    rows = store.conn.execute(
        "SELECT * FROM agent_questions WHERE account_id=? AND conversation_id=?"
        " AND status='open' ORDER BY created_at DESC LIMIT 20",
        (account_id, conversation_id)).fetchall()
    return [{"question_id": row["question_id"], "turn_id": row["turn_id"],
             "payload": json.loads(row["questions_json"]), "created_at": row["created_at"]}
            for row in rows]


def find_slot_for_figure(store, job_id: str, figure_no: int) -> str | None:
    """图位查找（M5-09 bind_asset_candidate 用）；账号域由调用方以 get_article 校验。"""
    row = store.conn.execute(
        "SELECT s.slot_id FROM asset_slots s WHERE s.article_id IN"
        " (SELECT article_id FROM jobs WHERE job_id=?) AND s.figure_no=?",
        (job_id, figure_no)).fetchone()
    return row["slot_id"] if row else None
