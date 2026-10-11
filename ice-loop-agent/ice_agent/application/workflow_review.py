"""工作流与审阅 RPC（M6-02/04/06；M5-08 摘要）。"""
from __future__ import annotations

import json
from typing import Any

from ..domain.types import new_id, now_iso, sha256_text
from ..workflow.invalidation import batch_plan, invalidation_preview
from . import Handler, register


@register
class WorkflowReviewHandler(Handler):
    METHODS = frozenset({
        "workflow.invalidation", "workflow.batch_plan",
        "review.center", "chat.summary",
    })

    def handle(self, method: str, params: dict) -> Any:
        return getattr(self, "_" + method.replace(".", "_"))(params)

    def _account(self) -> dict:
        return self.service._account()

    def _job_scoped(self, params: dict):
        """账号域校验后的 (engine, store, article)。用完关 store。"""
        try:
            engine, _, store = self.service._job_app(params["job_id"])
        except KeyError as exc:
            # 旧门面用 KeyError 表示"任务不存在"；handler 边界规范化为 ValueError
            # （RPC 层映射 VALIDATION_ERROR 稳定码）。
            raise ValueError(str(exc.args[0] if exc.args else exc)) from None
        job = store.get_job(params["job_id"])
        if not job:
            store.close()
            raise ValueError("任务不存在或不属于当前公众号")
        article = store.get_article(job["article_id"])
        if article["spec"].get("account_id", "ice-loop") != self._account()["id"]:
            store.close()
            raise ValueError("只能查看当前公众号的文章")
        return engine, store, article

    def _workflow_invalidation(self, params: dict) -> dict:
        changes = params.get("changes")
        if not isinstance(changes, list) or not changes:
            raise ValueError("请给出改动类型列表")
        return invalidation_preview([str(c) for c in changes])

    def _workflow_batch_plan(self, params: dict) -> dict:
        specs = params.get("articles")
        if not isinstance(specs, list) or not specs:
            raise ValueError("请给出批量文章清单")
        return batch_plan(specs, max_concurrency=int(params.get("max_concurrency", 3)))

    def _review_center(self, params: dict) -> dict:
        engine, store, article = self._job_scoped(params)
        try:
            job_id = params["job_id"]
            state = engine._load_state(job_id)
            body = state.get("integrated_md", "")
            job_view = self.service.call("jobs.get", {"job_id": job_id})
            runs_raw = job_view.get("runs") or {}
            runs = list(runs_raw.values()) if isinstance(runs_raw, dict) else list(runs_raw)
            slots = job_view.get("slots") or []
            claims = [dict(row) for row in store.conn.execute(
                "SELECT claim_id, text, risk_type, status, publish_day_check_required"
                " FROM claims WHERE article_id=?", (article["article_id"],))]
            from ..rules.markdown_ast import parse_markdown
            ast = parse_markdown(body)
            return {
                "job_id": job_id, "article_id": article["article_id"],
                "content": {"title": article.get("final_title") or article.get("topic"),
                            "characters": len(body), "headings": len(ast.headings()),
                            "code_blocks": len(ast.code_blocks()),
                            "image_placeholders": len(ast.image_placeholders())},
                "facts": {"claims": claims,
                          "unverified": sum(1 for c in claims if c["status"] != "verified")},
                "code": {"runs": [{"run_id": r.get("run_id"), "exit": r.get("exit_code"),
                                   "expected_error": r.get("expected_failure", False),
                                   "verdict": r.get("verdict")}
                                  for r in runs[:10]],
                         "all_runs_archived": bool(runs) and all(
                             r.get("exit_code") is not None for r in runs)},
                "images": {"slots": [{"figure_no": s.get("figure_no"),
                                      "valid": s.get("valid"),
                                      "candidate": s.get("candidate")}
                                     for s in slots]},
                "export": {"pending_placeholders": body.count("待配图："),
                           "readiness": article.get("readiness")},
                "note": "审阅中心是聚合视图；人工逐项决定走审批/提案流程",
            }
        finally:
            store.close()

    def _chat_summary(self, params: dict) -> dict:
        """会话摘要（M5-08）：确定性核心（轮次/brief/已答问题/最后意图），
        标明涵盖范围；模型侧润色留接口。原消息不动。"""
        conversation_id = params.get("conversation_id") or ""
        if not conversation_id:
            raise ValueError("缺少会话标识")
        account = self._account()
        store = self._store()
        try:
            conv = store.conn.execute(
                "SELECT id FROM creative_conversations WHERE id=? AND account_id=?",
                (conversation_id, account["id"])).fetchone()
            if not conv:
                raise ValueError("会话不存在或不属于当前公众号")
            messages = store.conn.execute(
                "SELECT id, role, content, status, created_at FROM creative_messages"
                " WHERE conversation_id=? ORDER BY rowid", (conversation_id,)).fetchall()
            total = len(messages)
            user_messages = [m["content"] for m in messages if m["role"] == "user"]
            from ..agent import storage as agent_store
            brief = agent_store.get_brief(store, account["id"], conversation_id)
            answered = store.conn.execute(
                "SELECT questions_json, answers_json FROM agent_questions"
                " WHERE account_id=? AND conversation_id=? AND status='answered'"
                " ORDER BY answered_at DESC LIMIT 10",
                (account["id"], conversation_id)).fetchall()
            qa = []
            for row in answered:
                payload = json.loads(row["questions_json"])
                answers = json.loads(row["answers_json"] or "{}").get("answers", {})
                for question in payload.get("questions", []):
                    qid = question.get("id")
                    if qid in answers:
                        qa.append({"question": question.get("question"), "answer": answers[qid]})
            digest = {
                "message_count": total,
                "user_turn_count": len(user_messages),
                "last_user_intent": (user_messages[-1][:400] if user_messages else ""),
                "brief": {k: v for k, v in (brief or {}).items() if k != "brief_id"},
                "clarifications": qa,
            }
            # 摘要只覆盖较早轮次：最近若干条保留原文，不纳入覆盖范围，
            # 这样摘要在后续几轮里仍然有效，直到更早范围发生变化。
            recent = 6
            earlier = messages[:-recent] if len(messages) > recent else []
            covers_to = earlier[-1]["id"] if earlier else ""
            covers_from = earlier[0]["id"] if earlier else ""
            existing = store.conn.execute(
                "SELECT summary_id FROM conversation_summaries WHERE conversation_id=?",
                (conversation_id,)).fetchone()
            summary_id = existing["summary_id"] if existing else new_id("sum")
            digest_json = json.dumps(digest, ensure_ascii=False)
            store.conn.execute(
                "INSERT INTO conversation_summaries (summary_id, account_id, conversation_id,"
                " covers_from, covers_to, digest_json, content_hash, created_at)"
                " VALUES (?,?,?,?,?,?,?,?)"
                " ON CONFLICT(conversation_id) DO UPDATE SET covers_to=excluded.covers_to,"
                " digest_json=excluded.digest_json, content_hash=excluded.content_hash",
                (summary_id, account["id"], conversation_id, covers_from, covers_to,
                 digest_json, sha256_text(digest_json), now_iso()))
            store.conn.commit()
            return {"summary_id": summary_id, "covers_from": covers_from,
                    "covers_to": covers_to, "digest": digest,
                    "note": "原消息全部保留可查；摘要是索引不是替代"}
        finally:
            store.close()

    def _store(self):
        _, _, store = self.service._app()
        return store
