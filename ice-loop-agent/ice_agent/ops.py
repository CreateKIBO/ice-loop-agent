"""运维面（M8-06/07/08）：健康摘要、临时残留登记、容量分类估算。

原则：只列不删——清理候选必须用户确认；正式证据/原稿/历史包永不自动清理。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

RUNTIME_DIRS = ("jobs", "assets", "resources", "staging", "screenshots",
                "captures", "image-variants", "run-evidence")
EVIDENCE_DIRS = {"run-evidence", "screenshots", "captures"}
CACHE_DIRS = {"staging", "image-variants"}


def health_snapshot(store, runtime: Path) -> dict[str, Any]:
    """健康页数据（M8-06）：版本/schema/队列/预算归属/最近错误类别/磁盘占用。"""
    from . import __version__
    schema_version = store.conn.execute("PRAGMA user_version").fetchone()[0]
    queue = store.conn.execute(
        "SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").fetchall()
    running_jobs = store.conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE state='running' OR lease IS NOT NULL").fetchone()[0]
    recent_errors = [dict(r) for r in store.conn.execute(
        "SELECT error, COUNT(*) AS n FROM model_invocations"
        " WHERE error IS NOT NULL AND error != ''"
        " GROUP BY error ORDER BY n DESC LIMIT 5")]
    chat_calls = store.conn.execute(
        "SELECT COUNT(*) FROM model_invocations WHERE conversation_id != ''").fetchone()[0]
    job_calls = store.conn.execute(
        "SELECT COUNT(*) FROM model_invocations WHERE job_id IS NOT NULL").fetchone()[0]
    return {"app_version": __version__, "schema_version": schema_version,
            "tasks": {row["state"]: row["n"] for row in queue},
            "running_jobs": running_jobs,
            "recent_model_errors": recent_errors,
            "invocations": {"conversation_scoped": chat_calls, "job_scoped": job_calls},
            "disk": capacity_breakdown(runtime),
            "fts5": _fts5_flag(store)}


def _fts5_flag(store) -> str:
    try:
        row = store.conn.execute(
            "SELECT value FROM knowledge_meta WHERE key='fts5'").fetchone()
        return ("1" if row and row[0] == "1" else "0")
    except sqlite3.OperationalError:
        return "0"


def capacity_breakdown(runtime: Path) -> dict[str, Any]:
    """容量分类（M8-07）：正式/证据/缓存分类字节数；逻辑字节估算，不承诺物理占用。"""
    runtime = Path(runtime)
    categories: dict[str, int] = {}
    for name in RUNTIME_DIRS:
        directory = runtime / name
        if not directory.exists():
            continue
        total = 0
        for path in directory.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue  # 文件被占用/消失：估算跳过，不中断
        categories[name] = total
    evidence = sum(categories.get(d, 0) for d in EVIDENCE_DIRS)
    cache = sum(categories.get(d, 0) for d in CACHE_DIRS)
    db_size = 0
    for suffix in ("", "-wal", "-shm"):
        db_file = runtime / f"app.db{suffix}"
        if db_file.exists():
            try:
                db_size += db_file.stat().st_size
            except OSError:
                pass
    return {"dirs": categories, "evidence_bytes": evidence, "cache_bytes": cache,
            "database_bytes": db_size,
            "note": "逻辑字节估算；证据与正式资源不自动清理，缓存可设配额"}


def staging_report(runtime: Path) -> dict[str, Any]:
    """临时残留登记（M8-08）：只列本应用 staging 下的候选目录，不删除。

    junction/外部路径/无法识别的条目一律保留并注明原因。
    """
    staging = Path(runtime) / "staging"
    candidates: list[dict[str, Any]] = []
    kept: list[dict[str, Any]] = []
    if staging.exists():
        for entry in staging.iterdir():
            try:
                if entry.is_symlink() or entry.is_junction():
                    kept.append({"name": entry.name, "reason": "符号链接/目录联接，不处理"})
                    continue
                if not entry.is_dir():
                    kept.append({"name": entry.name, "reason": "非常规条目，不处理"})
                    continue
                # 本应用创建的临时目录名形如 ice-*（tempfile 前缀由调用方保证）；
                # 无法识别命名的目录一律保留。
                stat = entry.stat()
                candidates.append({"name": entry.name, "path": str(entry),
                                   "mtime": stat.st_mtime,
                                   "safe_to_consider": entry.name.startswith("ice-")})
            except OSError as exc:
                kept.append({"name": entry.name, "reason": f"访问失败：{exc}"})
    return {"candidates": candidates, "kept": kept,
            "note": "仅列出候选；清理需用户确认具体清单"}
