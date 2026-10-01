"""可选本地 HTTP/SSE 服务（设计文档 §18 内部接口的 FastAPI 实现）。

零依赖原则：未安装 FastAPI 时 import 本模块会得到明确提示，CLI 与全部
核心功能不依赖本文件。真实桌面版按 §6.3 由 Electron 主进程托管。
"""
from __future__ import annotations

from contextlib import contextmanager
import secrets
from fastapi import Request

try:
    from fastapi import FastAPI, HTTPException
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "server 需要 FastAPI：pip install fastapi uvicorn；"
        "CLI（python -m ice_agent）不依赖本模块") from e


def create_app(engine_builder, *, access_token: str | None = None) -> FastAPI:
    """engine_builder() -> (engine, cfg, store)；绑定回环地址由启动方负责。"""
    app = FastAPI(title="ICE Loop Agent", version="0.2.0")
    app.state.access_token = access_token or secrets.token_urlsafe(32)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        from starlette.responses import JSONResponse
        if not secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + app.state.access_token):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    @contextmanager
    def connection():
        engine, cfg, store = engine_builder()
        try:
            yield engine, cfg, store
        finally:
            store.close()

    @app.get("/v1/health")
    def health():
        return {"status": "ok", "protocol": 1}

    @app.get("/v1/jobs/{job_id}")
    def job_snapshot(job_id: str):
        with connection() as (_, _, store):
            job = store.get_job(job_id)
            if job is None:
                raise HTTPException(status_code=404, detail="job not found")
            return {"job": job, "pending_approval": store.pending_approval(job_id)}

    @app.get("/v1/jobs/{job_id}/events")
    def job_events(job_id: str, after: int = 0):
        with connection() as (_, _, store):
            return {"events": store.job_events(job_id, after=after)}

    @app.post("/v1/jobs/{job_id}/resume")
    def resume(job_id: str):
        with connection() as (engine, _, store):
            if store.get_job(job_id) is None:
                raise HTTPException(404, "job not found")
            return {"job": engine.run(job_id)}

    @app.post("/v1/approvals/{approval_id}/decision")
    def decide(approval_id: str, body: dict):
        with connection() as (engine, _, store):
            ap = store.get_approval(approval_id)
            if ap is None:
                raise HTTPException(status_code=404, detail="approval not found")
            if not body.get("content_hash"):
                raise HTTPException(400, "content_hash required")
            try:
                ok = engine.decide(ap["job_id"], approval_id, body.get("decision", ""),
                                   body.get("note", ""), actor="api-user", choice=body.get("choice"),
                                   expect_hash=body["content_hash"])
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            if not ok:
                raise HTTPException(status_code=409, detail="approval expired")
            return {"ok": True}

    @app.post("/v1/operations/{operation_id}/reconcile")
    def reconcile(operation_id: str, body: dict):
        from .ledger.operations import LedgerError, OperationsLedger
        with connection() as (_, _, store):
            ledger = OperationsLedger(store)
            try:
                op = ledger.reconcile(
                    operation_id, body.get("decision", ""), body.get("evidence", ""),
                    provider_task_ref=body.get("provider_task_ref", ""),
                    provider_asset_refs=body.get("provider_asset_refs"))
            except LedgerError as e:
                raise HTTPException(status_code=400, detail=str(e))
            return {"operation": op}

    return app
