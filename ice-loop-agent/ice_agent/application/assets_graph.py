"""视觉资产与工作流图 RPC（M7-01/03/04/05/06/08；M6-05 数据源）。"""
from __future__ import annotations

import json
from typing import Any

from .. import assets_v2
from ..workflow.invalidation import NODE_ORDER
from . import Handler, register


@register
class AssetsGraphHandler(Handler):
    METHODS = frozenset({
        "stylepack.get", "stylepack.save",
        "promptv.lint", "promptv.revisions", "promptv.save",
        "slots.bind_run", "slots.run_binding",
        "downloads.stage", "downloads.bind", "downloads.list",
        "assets.capture_status",
        "workflow.graph",
    })

    def handle(self, method: str, params: dict) -> Any:
        return getattr(self, "_" + method.replace(".", "_"))(params)

    def _account(self) -> dict:
        return self.service._account()

    def _store(self):
        _, _, store = self.service._app()
        return store

    def _stylepack_get(self, _params: dict) -> dict:
        store = self._store()
        try:
            return assets_v2.get_style_pack(store, self._account()["id"])
        finally:
            store.close()

    def _stylepack_save(self, params: dict) -> dict:
        store = self._store()
        try:
            return assets_v2.save_style_pack(store, self._account()["id"],
                                             params.get("pack"),
                                             approve=bool(params.get("approve")))
        finally:
            store.close()

    def _promptv_lint(self, params: dict) -> dict:
        return assets_v2.lint_prompt(str(params.get("prompt_text", "")))

    def _promptv_save(self, params: dict) -> dict:
        job_id = params.get("job_id")
        figure_no = params.get("figure_no")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("缺少任务标识")
        if not isinstance(figure_no, int) or figure_no < 1:
            raise ValueError("缺少图位编号")
        text = params.get("prompt_text")
        if not isinstance(text, str) or not text.strip() or len(text) > 6000:
            raise ValueError("提示词不能为空或超过 6000 字符")
        store = self._store()
        try:
            return assets_v2.save_prompt_revision(
                store, self._account()["id"], job_id, figure_no, text,
                origin="user" if params.get("origin") == "user" else "agent")
        finally:
            store.close()

    def _promptv_revisions(self, params: dict) -> dict:
        store = self._store()
        try:
            rows = assets_v2.list_prompt_revisions(
                store, self._account()["id"], str(params.get("job_id", "")),
                params.get("figure_no"))
            return {"revisions": rows}
        finally:
            store.close()

    def _job_scoped_store(self, job_id: str):
        try:
            _, _, store = self.service._job_app(job_id)
        except KeyError as exc:
            raise ValueError(str(exc.args[0] if exc.args else exc)) from None
        return store

    def _slots_bind_run(self, params: dict) -> dict:
        job_id = params.get("job_id")
        figure_no = params.get("figure_no")
        run_id = params.get("run_id")
        source_hash = str(params.get("source_hash", ""))
        if not isinstance(job_id, str) or not isinstance(figure_no, int) or \
                not isinstance(run_id, str) or len(source_hash) < 8:
            raise ValueError("绑定需要任务/图位/运行标识与源码 hash")
        store = self._job_scoped_store(job_id)
        try:
            return assets_v2.bind_slot_run(
                store, self._account()["id"], job_id, figure_no, run_id, source_hash,
                input_hash=str(params.get("input_hash", "")),
                expected_result_kind=str(params.get("expected_result_kind", "success")),
                approved_error=bool(params.get("approved_error")),
                bound_by="user")
        finally:
            store.close()

    def _slots_run_binding(self, params: dict) -> dict:
        job_id = str(params.get("job_id", ""))
        figure_no = params.get("figure_no")
        if not job_id or not isinstance(figure_no, int):
            raise ValueError("缺少任务或图位编号")
        store = self._job_scoped_store(job_id)
        try:
            return {"binding": assets_v2.slot_run_binding(
                store, self._account()["id"], job_id, figure_no)}
        finally:
            store.close()

    def _downloads_stage(self, params: dict) -> dict:
        file_path = params.get("file_path")
        if not isinstance(file_path, str) or not file_path:
            raise ValueError("缺少下载文件路径")
        # Native downloads retain their original publication across account switches.
        # Missing account_id preserves the existing manual/RPC caller contract.
        owner = params.get("account_id")
        if "account_id" in params and (not isinstance(owner, str) or not owner):
            raise ValueError("下载来源公众号无效")
        account = self.service._account(owner)
        _, _, store = self.service._app(account_id=account["id"])
        try:
            return assets_v2.stage_download(store, account["id"], file_path,
                                            origin_url=str(params.get("origin_url", "")))
        finally:
            store.close()

    def _downloads_bind(self, params: dict) -> dict:
        download_id = params.get("download_id")
        if not isinstance(download_id, str) or not download_id:
            raise ValueError("缺少下载记录")
        store = self._store()
        try:
            return assets_v2.bind_download(store, self.service.runtime,
                                           self._account()["id"], download_id,
                                           params.get("slot_label"),
                                           job_id=params.get("job_id"),
                                           figure_no=params.get("figure_no"))
        finally:
            store.close()

    def _assets_capture_status(self, params: dict) -> dict:
        job_id = str(params.get("job_id", ""))
        figure_no = params.get("figure_no")
        if not job_id or not isinstance(figure_no, int):
            raise ValueError("缺少任务或图位编号")
        store = self._job_scoped_store(job_id)
        try:
            article = store.get_article(store.get_job(job_id)["article_id"])
            if article["spec"].get("account_id", "ice-loop") != self._account()["id"]:
                raise ValueError("只能查看当前公众号的截图")
            row = store.conn.execute(
                "SELECT state_json FROM checkpoints WHERE job_id=?", (job_id,)).fetchone()
            runs = json.loads(row["state_json"]).get("runs") or {} if row else {}
            return {"capture": assets_v2.capture_status(
                store, self._account()["id"], job_id, figure_no, runs)}
        finally:
            store.close()

    def _downloads_list(self, _params: dict) -> dict:
        store = self._store()
        try:
            return {"downloads": assets_v2.staging_list(store, self._account()["id"])}
        finally:
            store.close()

    def _workflow_graph(self, params: dict) -> dict:
        """工作流图数据（M6-05）：节点状态来自 steps/checkpoints 的真实投影。"""
        job_id = params.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("缺少任务标识")
        try:
            engine, _, store = self.service._job_app(job_id)
        except KeyError as exc:
            raise ValueError(str(exc.args[0] if exc.args else exc)) from None
        try:
            article = store.get_article(store.get_job(job_id)["article_id"])
            if article["spec"].get("account_id", "ice-loop") != self._account()["id"]:
                raise ValueError("只能查看当前公众号的工作流")
            job = store.get_job(job_id)
            steps = {row["node_key"]: dict(row) for row in store.conn.execute(
                "SELECT node_key, status, attempt, error, started_at, finished_at"
                " FROM steps WHERE job_id=?", (job_id,))}
            # 未落 steps 的节点用任务当前状态推断 queued/running
            nodes = []
            for index, node in enumerate(NODE_ORDER):
                step = steps.get(node)
                state = step["status"] if step else (
                    "running" if job["current_node"] == node and job["state"] == "running" else "queued")
                nodes.append({
                    "id": node, "order": index, "state": state,
                    "attempt": step["attempt"] if step else 0,
                    "error": (step["error"] or "")[:200] if step else "",
                })
            edges = [{"source": a, "target": b}
                     for a, b in zip(NODE_ORDER, NODE_ORDER[1:])]
            return {"job_id": job_id, "job_state": job["state"],
                    "current_node": job["current_node"], "nodes": nodes, "edges": edges,
                    "note": "图是任务状态投影；重跑预览见 workflow.invalidation"}
        finally:
            store.close()
