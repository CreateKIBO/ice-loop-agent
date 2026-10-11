"""文章编辑器 RPC handler（M3-01/03/04/05/06/07/08/09）。

复用领域服务：revisions.save_body（保存/恢复与冲突保护）、editorial（文档/
IR/补丁）、editorial.storage（草稿/提案持久化）。不新建平行正文写入。
"""
from __future__ import annotations

import json
from typing import Any

from .. import editorial
from ..domain.types import sha256_text
from ..editorial import storage as editorial_store
from . import Handler, register

_ALLOWED_OP_KINDS = frozenset({"replace", "delete", "insert_after"})
_ALLOWED_BLOCK_TYPES = frozenset({"paragraph", "heading", "code", "quote", "list",
                                  "image_slot", "run_output", "raw"})


@register
class ArticlesEditorHandler(Handler):
    METHODS = frozenset({
        "articles.document", "articles.editor_draft_save", "articles.editor_draft_get",
        "articles.editor_draft_clear", "articles.propose_patch", "articles.proposals_list",
        "articles.proposal_decide", "articles.approval_status",
    })

    def handle(self, method: str, params: dict) -> Any:
        return getattr(self, "_" + method.replace(".", "_"))(params)

    # ------------------------------------------------------------ 文档（M3-01）
    def _articles_document(self, params: dict) -> dict:
        service = self.service
        engine, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            if article["spec"].get("account_id", "ice-loop") != service._account()["id"]:
                raise ValueError("只能查看当前公众号的文章文档")
            revision_id = params.get("revision_id")
            if revision_id:
                from ..revisions import get_revision
                markdown = get_revision(store, article["article_id"], revision_id)["content"]
            else:
                markdown = engine._load_state(params["job_id"]).get("integrated_md", "")
                revision_id = None
            content_hash = sha256_text(markdown)
            cached = editorial_store.get_article_document(store, article["article_id"],
                                                          revision_id or content_hash)
            document = cached["document"] if cached and cached["markdown_hash"] == content_hash \
                else editorial.parse_document(markdown)
            editorial_store.save_article_document(store, article["article_id"],
                                                  revision_id or content_hash, document, content_hash)
            slots = {}
            for block in document["blocks"]:
                if block["type"] == "image_slot":
                    candidates = store.conn.execute(
                        "SELECT candidate_id, source, sha256, review_status FROM asset_candidates"
                        " WHERE slot_id IN (SELECT slot_id FROM asset_slots"
                        " WHERE article_id=? AND figure_no=?)",
                        (article["article_id"], block["figure_no"])).fetchall()
                    slots[str(block["figure_no"])] = [dict(row) for row in candidates]
            return {"document": document, "markdown": markdown, "content_hash": content_hash,
                    "revision_id": revision_id, "slots": slots}
        finally:
            store.close()

    # ------------------------------------------------------------ 工作草稿（M3-04）
    def _articles_editor_draft_save(self, params: dict) -> dict:
        service = self.service
        engine, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            if article["spec"].get("account_id", "ice-loop") != service._account()["id"]:
                raise ValueError("只能保存当前公众号的草稿")
            content = params.get("content")
            if not isinstance(content, str) or not 1 <= len(content) <= 100000:
                raise ValueError("草稿内容不能为空或超过长度上限")
            content_hash = sha256_text(content)
            changed = editorial_store.save_editor_draft(
                store, service._account()["id"], article["article_id"], content,
                params.get("base_revision"), content_hash)
            draft = editorial_store.get_editor_draft(store, service._account()["id"],
                                                     article["article_id"])
            return {"content_hash": content_hash, "changed": changed, "saved_at": draft["updated_at"]}
        finally:
            store.close()

    def _articles_editor_draft_get(self, params: dict) -> dict:
        service = self.service
        _, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            draft = editorial_store.get_editor_draft(store, service._account()["id"],
                                                     article["article_id"])
            return {"draft": draft}
        finally:
            store.close()

    def _articles_editor_draft_clear(self, params: dict) -> dict:
        service = self.service
        _, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            editorial_store.clear_editor_draft(store, service._account()["id"],
                                               article["article_id"])
            return {"cleared": True}
        finally:
            store.close()

    # ------------------------------------------------------------ 提案（M3-05/06/07）
    def _validate_ops(self, base_document: dict, ops: Any) -> None:
        if not isinstance(ops, list) or not ops or len(ops) > 50:
            raise ValueError("提案必须包含 1–50 个修改项")
        hashes = editorial.block_hashes(base_document)
        for index, op in enumerate(ops):
            if not isinstance(op, dict) or op.get("op") not in _ALLOWED_OP_KINDS:
                raise ValueError(f"第 {index + 1} 项修改类型不支持")
            block_id = op.get("block_id")
            if not isinstance(block_id, str) or block_id not in hashes:
                raise ValueError(f"第 {index + 1} 项的目标块不在基线版本中")
            if op.get("old_hash") != hashes[block_id]:
                raise ValueError(f"第 {index + 1} 项与基线版本内容不符，请基于最新文档重新生成")
            if op["op"] == "replace":
                text = op.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 20000:
                    raise ValueError(f"第 {index + 1} 项替换文本不能为空或超长")
            elif op["op"] == "insert_after":
                new_block = op.get("new_block")
                if not isinstance(new_block, dict) or new_block.get("type") not in _ALLOWED_BLOCK_TYPES:
                    raise ValueError(f"第 {index + 1} 项插入块类型未注册")

    def _articles_propose_patch(self, params: dict) -> dict:
        service = self.service
        engine, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            if article["spec"].get("account_id", "ice-loop") != service._account()["id"]:
                raise ValueError("只能为当前公众号的文章创建提案")
            base_revision = params.get("base_revision")
            if not base_revision or base_revision == "current":
                # 'current' = 以创建提案那一刻的正文快照为基线（任务可能还没有
                # 人工 revision；快照随提案保存，后续重放不依赖文档重建）。
                base_revision = "current"
            if base_revision == "current":
                base_markdown = engine._load_state(params["job_id"]).get("integrated_md", "")
                if not base_markdown.strip():
                    raise ValueError("正文还没有可作基线的内容")
                base_revision = "current:" + sha256_text(base_markdown)
                base_document = editorial.parse_document(base_markdown)
                base_hash = sha256_text(base_markdown)
            else:
                from ..revisions import get_revision
                base = get_revision(store, article["article_id"], base_revision)
                base_markdown = base["content"]
                base_document = editorial.parse_document(base_markdown)
                base_hash = base["content_hash"]
            ops = params.get("ops")
            self._validate_ops(base_document, ops)
            proposal = editorial_store.create_edit_proposal(
                store, service._account()["id"], article["article_id"],
                base_revision, base_hash, base_document, ops,
                str(params.get("reason", ""))[:500], params.get("source_turn"))
            return {"proposal": proposal}
        finally:
            store.close()

    def _articles_proposals_list(self, params: dict) -> dict:
        service = self.service
        _, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            proposals = editorial_store.list_edit_proposals(
                store, service._account()["id"], article["article_id"],
                include_decided=bool(params.get("include_decided")))
            return {"proposals": proposals}
        finally:
            store.close()

    def _articles_proposal_decide(self, params: dict) -> dict:
        service = self.service
        engine, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            if article["spec"].get("account_id", "ice-loop") != service._account()["id"]:
                raise ValueError("只能处理当前公众号的提案")
            proposal = editorial_store.get_edit_proposal(store, params.get("proposal_id"))
            if proposal["article_id"] != article["article_id"] or \
                    proposal["account_id"] != service._account()["id"]:
                raise ValueError("提案不属于当前文章或公众号")
            if proposal["status"] != "pending":
                raise ValueError("提案已处理过，请查看处理结果")
            decisions = params.get("decisions")
            if not isinstance(decisions, list) or len(decisions) != len(proposal["ops"]):
                raise ValueError("必须对每一项修改给出决定")
            for decision in decisions:
                if not isinstance(decision, dict) or \
                        decision.get("decision") not in ("accept", "reject", "new_text"):
                    raise ValueError("决定必须是 accept/reject/new_text")
                if decision["decision"] == "new_text" and \
                        (not isinstance(decision.get("text"), str) or not decision["text"].strip()):
                    raise ValueError("改后接受必须提供新文本")
            base_document = proposal["base_document"]
            current_md = engine._load_state(params["job_id"]).get("integrated_md", "")
            current_hash = sha256_text(current_md)
            current_document = editorial.parse_document(current_md)
            merged = editorial.apply_proposal_ops(base_document, current_document,
                                                  proposal["ops"], decisions)
            applied_count = sum(1 for item in merged["applied"] if item["result"] == "applied")
            conflicts = merged["conflicts"]
            if applied_count == 0:
                status = "rejected" if not conflicts else "conflict"
                outcome = {"applied": merged["applied"], "conflicts": conflicts}
                editorial_store.finish_edit_proposal(store, proposal["proposal_id"], status, outcome)
                return {"status": status, "applied": merged["applied"], "conflicts": conflicts,
                        "revision_id": None, "content_hash": current_hash}
            new_md = editorial.serialize_document(merged["document"])
            if sha256_text(new_md) == current_hash:
                editorial_store.finish_edit_proposal(store, proposal["proposal_id"],
                                                     "rejected", {"applied": merged["applied"], "conflicts": conflicts})
                return {"status": "rejected", "applied": merged["applied"], "conflicts": conflicts,
                        "revision_id": None, "content_hash": current_hash}
            from ..revisions import save_body
            saved = save_body(engine, store, params["job_id"], new_md, current_hash,
                              service._account()["id"])
            status = "applied" if not conflicts else "partially_applied"
            outcome = {"applied": merged["applied"], "conflicts": conflicts,
                       "revision_id": saved["revision_id"]}
            editorial_store.finish_edit_proposal(store, proposal["proposal_id"], status, outcome)
            editorial_store.clear_editor_draft(store, service._account()["id"],
                                               article["article_id"])
            return {"status": status, "applied": merged["applied"], "conflicts": conflicts,
                    "revision_id": saved["revision_id"], "content_hash": saved["content_hash"],
                    "evidence_errors": saved.get("evidence_errors")}
        finally:
            store.close()

    # ------------------------------------------------------------ 审批状态（M3-09）
    def _articles_approval_status(self, params: dict) -> dict:
        service = self.service
        engine, _, store = service._job_app(params["job_id"])
        try:
            article = store.get_article(store.get_job(params["job_id"])["article_id"])
            if article["spec"].get("account_id", "ice-loop") != service._account()["id"]:
                raise ValueError("只能查看当前公众号的审批状态")
            current_md = engine._load_state(params["job_id"]).get("integrated_md", "")
            current_hash = sha256_text(current_md)
            # 正文级审批锚点：chat 候选采用并进入配图交接时登记的 (job, draft, content_hash)。
            # 正文在其后被修改 → 旧审批基线过期（只读比较，不改历史审批记录）。
            handoff = store.conn.execute(
                "SELECT draft_id, content_hash FROM creative_asset_handoffs"
                " WHERE job_id=? ORDER BY rowid DESC LIMIT 1", (params["job_id"],)).fetchone()
            gates = [dict(row) for row in store.conn.execute(
                "SELECT approval_id, scope, content_hash, status, decided_at FROM approvals"
                " WHERE job_id=? AND status='approved' ORDER BY rowid DESC LIMIT 10",
                (params["job_id"],))]
            pending = store.pending_approval(params["job_id"])
            if handoff:
                return {"current_hash": current_hash, "approved_hash": handoff["content_hash"],
                        "stale": handoff["content_hash"] != current_hash,
                        "approved_scope": "draft_handoff",
                        "decided_at": None,
                        "workflow_gates": gates, "pending_approval": pending}
            return {"current_hash": current_hash, "approved_hash": None, "stale": False,
                    "approved_scope": None, "decided_at": None,
                    "workflow_gates": gates, "pending_approval": pending}
        finally:
            store.close()
