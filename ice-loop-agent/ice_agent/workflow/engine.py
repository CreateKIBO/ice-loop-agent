"""工作流引擎：节点调度、审核门暂停/恢复、步骤复用与事件流（§8 / §17.3）。

- 同输入 hash 的已完成步骤在恢复时直接复用，不重复执行；
- 审核门暂停任务（awaiting_approval）；决定与内容 hash 绑定；
- 退出前先落盘 state.json 再提交步骤状态，崩溃后从 current_node 重入；
- 恢复时若存在 needs_reconciliation 操作，先阻塞在外部副作用对账（§13）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from ..config import RuntimeConfig
from ..domain.store import Store
from ..domain.types import WORKFLOW_NODES, new_id, now_iso, sha256_json, sha256_text
from ..execution.runner import CodeRunner
from ..ledger.operations import OperationsLedger
from ..llm.router import RoleRouter
from ..llm.errors import ModelError
from ..paths import atomic_write_text
from .nodes import (
    NODE_FUNCS,
    ApprovalPause,
    NodeContext,
    NodeFailed,
    UserActionRequired,
)

AutoApprover = Callable[[str, dict[str, Any]], tuple[str, str, int | None]]


class WorkflowEngine:
    def __init__(self, cfg: RuntimeConfig, store: Store, router: RoleRouter,
                 runner: CodeRunner | None = None, ledger: OperationsLedger | None = None,
                 exporter: Callable[[NodeContext], dict[str, Any]] | None = None):
        self.cfg = cfg
        self.store = store
        self.router = router
        self.runner = runner or CodeRunner(cfg.runtime_root)
        self.ledger = ledger or OperationsLedger(store)
        self.exporter = exporter
        self.should_stop: Callable[[], bool] | None = None

    # ------------------------------------------------------------ 建任务
    def create_job(self, spec: dict[str, Any], *,
                   limits: dict[str, Any] | None = None,
                   mode: str = "semi_auto",
                   on_created: Callable[[str], None] | None = None) -> tuple[str, str]:
        series = spec.get("series", "PY")
        episode = int(spec.get("episode", 1))
        job_id = new_id("job")
        article_id = new_id("art")
        default_limits = {
            "max_model_calls":
                self.cfg.profile.get("limits", {}).get("per_article_model_calls", 20),
            "max_image_candidates": 2,
            "max_auto_revision_rounds":
                self.cfg.profile.get("limits", {}).get("max_auto_revision_rounds", 2),
        }
        default_limits.update(limits or {})
        import copy
        state: dict[str, Any] = {"spec": spec, "rules_profile_snapshot": copy.deepcopy(self.cfg.profile)}
        # The queue binding (when present) shares this connection/transaction.
        # After commit the DB checkpoint is authoritative even if the file mirror fails.
        with self.store.transaction():
            self.store.create_article({
                'article_id':article_id,'series':series,'episode':episode,
                'topic':spec.get('topic',''),'readiness':'draft','spec':spec,
            },commit=False)
            self.store.create_job({
                'job_id':job_id,'article_id':article_id,'workflow':'new_article_v1',
                'state':'queued','current_node':WORKFLOW_NODES[0],'mode':mode,
                'model_route_snapshot':self.router.snapshot,'limits':default_limits,
            },commit=False)
            self.store.save_checkpoint(job_id,state,commit=False)
            self.store.append_event(job_id,'job.created',{
                'article_id':article_id,'mode':mode,'route':self.router.snapshot})
            if on_created is not None:
                on_created(job_id)
        self._write_state_file(job_id,state)
        return job_id, article_id

    # -------------------------------------------------------------- 运行
    def _halted(self, job_id: str) -> bool:
        if self.should_stop and self.should_stop():
            return True
        from ..task_lifecycle import task_is_hidden
        job = self.store.get_job(job_id)
        return not job or job['state'] in ('paused', 'cancelled') or task_is_hidden(self.store, job_id)

    def _update_if_active(self, job_id: str, *, allow_paused: bool = False, **fields: Any) -> bool:
        from ..task_lifecycle import task_is_hidden
        # The archive marker and worker state must be checked under one write
        # lock; otherwise an in-flight result could overwrite the pause request.
        with self.store.transaction():
            job = self.store.get_job(job_id)
            if (self.should_stop and self.should_stop()) or not job or task_is_hidden(self.store, job_id) or job['state'] == 'cancelled' or (
                    job['state'] == 'paused' and not allow_paused):
                return False
            self.store.update_job(job_id, **fields)
            return True

    def run(self, job_id: str, *,
            auto_approver: AutoApprover | None = None,
            actor: str = "user") -> dict[str, Any]:
        existing = self.store.get_job(job_id)
        if existing and self.store.get_article(existing['article_id'])['spec'].get('image_only'):
            raise ValueError('补图任务不能进入文章改写流水线，请使用图位计划和补图导出')
        token = new_id("lease")
        if not self.store.claim_job(job_id, token):
            job = self.store.get_job(job_id)
            if job is None:
                raise KeyError(job_id)
            return job
        previous_stop = getattr(self.runner, 'should_stop', None)
        self.runner.should_stop = lambda: self._halted(job_id) or bool(previous_stop and previous_stop())
        try:
            return self._run(job_id, auto_approver=auto_approver, actor=actor)
        except Exception as exc:
            if self._halted(job_id):
                return self.store.get_job(job_id)
            self._fail_step(job_id, self.store.get_job(job_id)["current_node"],
                            getattr(exc, "code", type(exc).__name__), str(exc))
            self._update_if_active(job_id, state="failed", pause_reason=str(exc))
            return self.store.get_job(job_id)
        finally:
            self.runner.should_stop = previous_stop
            self.store.release_job(job_id, token)

    def _run(self, job_id: str, *, auto_approver=None, actor="user") -> dict[str, Any]:
        """推进任务直到完成、审核门或用户动作。

        auto_approver：联调/预批准模式使用，签名 (scope, payload) ->
        (decision, note, choice)；decision 为 approve/reject。它走同一条
        审核决定代码路径（记录决定者与内容 hash），不是隐藏跳过审核。
        """
        job = self.store.get_job(job_id)
        if job is None:
            raise KeyError(f"任务不存在：{job_id}")
        if job["state"] in ("completed", "cancelled"):
            return job
        from ..task_lifecycle import task_is_hidden
        if task_is_hidden(self.store, job_id):
            return job
        if job["state"] == "failed" and job.get("pause_reason", "").startswith(
                "APPROVAL_REJECTED"):
            return job
        state = self._load_state(job_id)
        if state.get("rules_profile_snapshot"):
            self.cfg.profile = state["rules_profile_snapshot"]
        self.router.restore(job.get("model_route_snapshot") or {})
        self.router.cancelled = lambda: self._halted(job_id)
        self.router.on_delta = lambda node, piece: self.store.append_event(
            job_id, "model.delta", {"node": node, "content": piece})
        article = self.store.get_article(job["article_id"])
        ctx = self._make_ctx(job, article, state)
        # 恢复检查：存在未对账的外部操作时，先停在用户动作（§13）
        pending_ops = self.ledger.needs_reconciliation(job["article_id"])
        if pending_ops:
            self._update_if_active(job_id, state="awaiting_user",
                                  pause_reason="存在 sending/unknown 操作，"
                                  "请先完成对账（reconcile）再继续")
            self.store.append_event(job_id, "job.paused",
                                    {"reason": "operations_need_reconciliation",
                                     "operations": [o["operation_id"]
                                                    for o in pending_ops]})
            return self.store.get_job(job_id)

        # CLI callers may explicitly resume a paused job. Desktop workers enter
        # with queued state, so a later pause cannot be mistaken for that resume.
        if not self._update_if_active(job_id, allow_paused=job['state'] == 'paused',
                                      state="running", pause_reason=""):
            return self.store.get_job(job_id)
        nodes = list(WORKFLOW_NODES)
        start = nodes.index(job["current_node"]) \
            if job["current_node"] in nodes else 0
        i = start
        gate_retries: dict[str, int] = {}
        _MAX_GATE_RETRIES = 5   # 防御：payload 不确定导致审核门反复重建时熔断
        while i < len(nodes):
            current = self.store.get_job(job_id)
            if self._halted(job_id):
                return current
            node = nodes[i]
            if not self._update_if_active(job_id, current_node=node):
                return self.store.get_job(job_id)
            self.store.append_event(job_id, "step.started", {"node": node})
            ctx.job = self.store.get_job(job_id)
            ctx.article = self.store.get_article(job["article_id"])
            func = NODE_FUNCS[node]
            input_hash = sha256_json({"node": node, "state": _hashable_state(state)})
            done = self.store.find_completed_step(job_id, node, input_hash)
            if done is not None:
                self.store.append_event(job_id, "step.completed",
                                        {"node": node, "reused": True})
                i += 1
                continue
            try:
                if node == "export":
                    state["_exporter"] = self.exporter
                outputs = func(ctx)
            except ApprovalPause as ap:
                self._save_state(job_id, state)
                if self._halted(job_id):
                    return self.store.get_job(job_id)
                approver=auto_approver
                from ..automation import SCOPES, editorial_decision
                if approver is None and state['spec'].get('production_mode')=='auto_prepare' and ap.scope in SCOPES:
                    approver=editorial_decision
                if approver is not None:
                    gate_retries[node] = gate_retries.get(node, 0) + 1
                    if gate_retries[node] > _MAX_GATE_RETRIES:
                        self._fail_step(
                            job_id, node, "GATE_LOOP",
                            f"审核门 {ap.scope} 连续重建超过 {_MAX_GATE_RETRIES} 次；"
                            "payload 应为确定性内容（不含易变 ID），请检查节点实现")
                        self._update_if_active(
                            job_id, state="failed",
                            pause_reason=f"GATE_LOOP（{node}）：审核门反复重建")
                        return self.store.get_job(job_id)
                    decision, note, choice = approver(ap.scope, ap.payload)
                    ok = self.decide(job_id, ap.approval_id, decision, note,
                                     actor='auto:preparation' if auto_approver is None else f"auto:{actor}", choice=choice)
                    if ok and decision == "approve":
                        continue        # 重入节点，此次审核门放行
                    if ok and decision == "reject":
                        self._update_if_active(
                            job_id, state="failed",
                            pause_reason=f"APPROVAL_REJECTED({ap.scope})：{note}")
                        self.store.append_event(job_id, "step.failed",
                                                {"node": node, "code":
                                                 "APPROVAL_REJECTED"})
                        return self.store.get_job(job_id)
                self._update_if_active(job_id, state="awaiting_approval",
                                      pause_reason=f"等待审核（{ap.scope}）"
                                      f"：{ap.approval_id}")
                return self.store.get_job(job_id)
            except UserActionRequired as ua:
                self._save_state(job_id, state)
                if self._halted(job_id):
                    return self.store.get_job(job_id)
                self._fail_step(job_id, node, "AWAITING_USER", str(ua))
                self._update_if_active(job_id, state="awaiting_user",
                                      pause_reason=str(ua))
                return self.store.get_job(job_id)
            except NodeFailed as nf:
                self._save_state(job_id, state)
                if self._halted(job_id):
                    return self.store.get_job(job_id)
                self._fail_step(job_id, node, nf.code, str(nf))
                self._update_if_active(job_id, state="failed",
                                      pause_reason=f"{nf.code}（{node}）：{nf}")
                return self.store.get_job(job_id)
            except Exception as exc:
                self._save_state(job_id, state)
                if self._halted(job_id) or getattr(exc, "code", "") == "CANCELLED":
                    return self.store.get_job(job_id)
                self._fail_step(job_id, node, getattr(exc, "code", type(exc).__name__), str(exc))
                self._update_if_active(job_id, state="failed", pause_reason=str(exc))
                return self.store.get_job(job_id)
            state.pop("_exporter", None)
            if self._halted(job_id):
                # Retain a completed in-flight node's output, without proceeding
                # into another node, creating an approval or exporting a package.
                self._save_state(job_id, state)
                return self.store.get_job(job_id)
            clean = {k: v for k, v in state.items() if not k.startswith("_")}
            with self.store.transaction():
                self.store.save_checkpoint(job_id, clean, commit=False)
                self.store.upsert_step({
                    "step_id": new_id("stp"), "job_id": job_id, "node_key": node,
                    "input_hash": input_hash, "status": "completed",
                    "output_refs": outputs or {}, "started_at": now_iso(),
                    "finished_at": now_iso()}, commit=False)
                if i + 1 < len(nodes):
                    self.store.conn.execute("UPDATE jobs SET current_node=? WHERE job_id=?", (nodes[i + 1], job_id))
            self._write_state_file(job_id, clean)
            self.store.append_event(job_id, "step.completed",
                                    {"node": node, **(outputs or {})})
            i += 1
        if self._halted(job_id):
            return self.store.get_job(job_id)
        if not self._update_if_active(job_id, state="completed", pause_reason=""):
            return self.store.get_job(job_id)
        self.store.append_event(job_id, "job.completed",
                                {"article_id": job["article_id"]})
        return self.store.get_job(job_id)

    # -------------------------------------------------------------- 审核
    def decide(self, job_id: str, approval_id: str, decision: str,
               note: str = "", *, actor: str = "user",
               choice: int | None = None,
               expect_hash: str | None = None) -> bool:
        ap = self.store.get_approval(approval_id)
        if ap is None or ap["job_id"] != job_id:
            return False
        if choice is not None:
            candidates = ap["payload"].get("candidates", ap["payload"].get("directions", []))
            if not isinstance(choice, int) or isinstance(choice, bool) or not 0 <= choice < len(candidates):
                raise ValueError("选择序号超出候选范围")
        with self.store.transaction():
            ok = self.store.decide_approval(approval_id, decision, note, actor,
                                            expect_hash, commit=False)
            if ok:
                self.store.conn.execute("INSERT INTO approval_choices VALUES (?,?) ON CONFLICT(approval_id) DO UPDATE SET choice=excluded.choice", (approval_id, choice))
                self.store.append_event(job_id, "approval.decided", {
                    "approval_id": approval_id, "scope": ap["scope"],
                    "decision": decision, "actor": actor, "choice": choice})
        return ok

    # ------------------------------------------------------- 资产收尾
    def import_asset(self, job_id: str, figure_no: int, file_path: Path,
                     *, accept: bool = True) -> dict[str, Any]:
        """手动导入一张图（实截/生图均可）：校验文件 → 登记候选 → 标记采纳。"""
        from ..providers.tapnow import ManualImportProvider

        job = self.store.get_job(job_id)
        if job is None:
            raise KeyError(f"任务不存在：{job_id}")
        slots = [s for s in self.store.article_slots(job["article_id"])
                 if s.get("figure_no") == figure_no]
        if not slots:
            raise KeyError(f"图{figure_no} 对应的图位不存在（job {job_id}）")
        provider = ManualImportProvider(self.cfg.runtime_root / "assets")
        candidate = provider.import_asset(self.store, slots[0], file_path)
        if accept:
            self.store.conn.execute(
                "UPDATE asset_candidates SET review_status='accepted'"
                " WHERE candidate_id=?",
                (candidate["candidate_id"],))
            self.store.conn.commit()
            slots[0]["selected_candidate"] = candidate["candidate_id"]
            self.store.upsert_slot(slots[0])
        state = self._load_state(job_id)
        state["slots"] = self.store.article_slots(job["article_id"])
        self._save_state(job_id, state)
        self.store.update_article(job["article_id"], readiness="assets_pending")
        self.store.append_event(job_id, "asset.imported", {
            "figure_no": figure_no, "candidate_id": candidate["candidate_id"],
            "accepted": accept})
        return candidate

    def refinalize(self, job_id: str) -> dict[str, Any]:
        """手动资产导入后复检并重新导出（final_check + export，绕过步骤复用）。"""
        from .nodes import node_final_check, node_export

        job = self.store.get_job(job_id)
        if job and self.store.get_article(job['article_id'])['spec'].get('image_only'):
            from ..supplements import finalize
            account_id=self.store.get_article(job['article_id'])['spec']['account_id']
            return finalize(self,self.store,job_id,account_id)
        if job is None:
            raise KeyError(f"任务不存在：{job_id}")
        if job["state"] not in ("completed",):
            raise ValueError("仅完成写作的任务可复检导出；请先完成审核")
        article = self.store.get_article(job["article_id"])
        state = self._load_state(job_id)
        ctx = self._make_ctx(job, article, state)
        final = node_final_check(ctx)
        article = self.store.get_article(job["article_id"])   # 复检后的最新状态
        ctx.article = article
        self._save_state(job_id, state)
        self.store.append_event(job_id, "step.completed",
                                {"node": "final_check", "refinalize": True,
                                 **final})
        state["_exporter"] = self.exporter
        export = node_export(ctx)
        state.pop("_exporter", None)
        state["export_result"] = export
        self._save_state(job_id, state)
        self.store.append_event(job_id, "step.completed",
                                {"node": "export", "refinalize": True})
        return {"final_check": final, "export": export,
                "readiness": article.get("readiness")}

    # ------------------------------------------------------------ 状态
    def status(self, job_id: str) -> dict[str, Any]:
        job = self.store.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        pending = self.store.pending_approval(job_id)
        return {
            "job": job,
            "pending_approval": pending,
            "events_tail": self.store.job_events(job_id, after=0)[-8:],
        }

    # ------------------------------------------------------------ 内部
    def _make_ctx(self, job, article, state) -> NodeContext:
        return NodeContext(self.cfg, self.store, self.router, self.runner,
                           self.ledger, job, article, state)

    def _save_state(self, job_id: str, state: dict[str, Any]) -> None:
        d = self.cfg.job_dir(job_id)
        clean = {k: v for k, v in state.items() if not k.startswith("_")}
        self.store.save_checkpoint(job_id, clean)
        self._write_state_file(job_id, clean)

    def _write_state_file(self, job_id: str, clean: dict) -> None:
        atomic_write_text(self.cfg.job_dir(job_id) / "state.json", json.dumps(clean, ensure_ascii=False, indent=2))

    def _load_state(self, job_id: str) -> dict[str, Any]:
        checkpoint = self.store.load_checkpoint(job_id)
        if checkpoint is not None:
            return checkpoint
        f = self.cfg.job_dir(job_id) / "state.json"
        if f.exists():
            return json.loads(f.read_text(encoding="utf-8"))
        return {}

    def _fail_step(self, job_id: str, node: str, code: str, error: str) -> None:
        self.store.upsert_step({
            "step_id": new_id("stp"), "job_id": job_id, "node_key": node,
            "input_hash": "failed", "status": "failed",
            "error": f"[{code}] {error}", "started_at": now_iso(),
            "finished_at": now_iso()})
        self.store.append_event(job_id, "step.failed",
                                {"node": node, "code": code})


def _hashable_state(state: dict[str, Any]) -> dict[str, Any]:
    """步骤复用只看影响后续节点的关键字段；长文本以哈希摘要参与。"""
    keys = ("working_title", "topic_payload", "outline", "claims", "draft_md",
            "runs", "integrated_md", "final_title", "abstract", "slots",
            "style_report", "article_review_report")

    def compact(v):
        if isinstance(v, str) and len(v) > 512:
            return sha256_text(v)
        return v

    return {k: compact(state.get(k)) for k in keys if k in state}
