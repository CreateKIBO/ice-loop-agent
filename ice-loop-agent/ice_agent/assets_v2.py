"""视觉资产 v2（M7）：StylePack 版本化、提示词 lint/候选、图位-Run 绑定、下载待归档。

复用边界：资源导入/调色板/推荐沿用 WorkspaceAssets 与 visual_assets；品牌
7 张原图沿用 style_presets（hash 不变）。本模块只加版本化/绑定/归档语义。
SQL 全部在 storage 或本文件且全字面量+参数绑定。
"""
from __future__ import annotations

import json
import os
import stat
import re
import uuid
from hashlib import sha256
from pathlib import Path
from typing import Any

from .agent.storage import find_slot_for_figure
from .domain.types import new_id, now_iso

# ------------------------------------------------------------- StylePack
DEFAULT_PACK: dict[str, Any] = {
    "colors": {"primary": "#2448DB", "ink": "#15191F", "background": "#F3F2ED"},
    "fonts": {"heading": "系统黑体优先", "body": "系统宋黑混排", "fallback_declared": True},
    "layout": {"density": "comfortable", "margin_ratio": 0.08},
    "templates": {"cover": {"mode": "edit_existing", "editable_regions": ["title", "episode"],
                            "protected_regions": ["identity", "logo-shapes"]}},
    "forbidden": ["3D", "gradients", "shadows", "real product logos"],
    "brand_text_exact": "可执行的想象。",
    "source": "default",
}


def get_style_pack(store, account_id: str) -> dict[str, Any]:
    row = store.conn.execute(
        "SELECT pack_id, version, pack_json, status, approved_at FROM style_packs"
        " WHERE account_id=? ORDER BY version DESC LIMIT 1", (account_id,)).fetchone()
    if not row:
        return {"pack_id": None, "version": 0, "status": "none",
                "pack": dict(DEFAULT_PACK), "approved_at": None,
                "note": "尚未建立样式包；默认值只读展示，修改后保存为新版本"}
    return {"pack_id": row["pack_id"], "version": row["version"],
            "status": row["status"], "approved_at": row["approved_at"],
            "pack": json.loads(row["pack_json"])}


def save_style_pack(store, account_id: str, pack: dict[str, Any], *,
                    approve: bool = False) -> dict[str, Any]:
    if not isinstance(pack, dict):
        raise ValueError("样式包必须是对象")
    merged = {**DEFAULT_PACK, **pack}
    current = get_style_pack(store, account_id)
    merged["source"] = str(merged.get("source", "user"))[:40]
    version = current["version"] + 1
    pack_id = new_id("pack")
    with store.transaction():
        store.conn.execute(
            "INSERT INTO style_packs (pack_id, account_id, version, pack_json, status,"
            " approved_at, created_at) VALUES (?,?,?,?,?,?,?)",
            (pack_id, account_id, version, json.dumps(merged, ensure_ascii=False),
             "approved" if approve else "draft",
             now_iso() if approve else None, now_iso()))
    return {"pack_id": pack_id, "version": version,
            "status": "approved" if approve else "draft"}


# ------------------------------------------------------------- 提示词 lint
LINT_CHECKS = ("use_case", "canvas", "colors", "exact_text", "layout", "style", "forbidden")


def lint_prompt(prompt_text: str) -> dict[str, Any]:
    """确定性七要素 lint（M7-04）：缺项/残留期号/矛盾与风险提示。

    只检查可确定性判断的项；语义判断属于人工/视觉模型，不冒充准确率。
    """
    text = prompt_text or ""
    lowered = text.lower()
    missing: list[str] = []
    warnings: list[str] = []
    checks: dict[str, bool] = {
        "use_case": bool(re.search(r"use case\s*:", lowered)),
        "canvas": bool(re.search(r"(canvas|ratio)\s*:", lowered)) or bool(re.search(r"\b\d+\s*:\s*\d+\b", text)),
        "colors": bool(re.search(r"(colors?|palette)\s*:", lowered)) or bool(re.search(r"#[0-9a-f]{6}", text, re.I)),
        "exact_text": bool(re.search(r"(text in image|exact(ly)?)\s*:?", lowered)),
        "layout": bool(re.search(r"layout\s*:", lowered)),
        "style": bool(re.search(r"style\s*:", lowered)),
        "forbidden": bool(re.search(r"(forbidden|no\s+3d|avoid)\s*:?", lowered)),
    }
    for name, present in checks.items():
        if not present:
            missing.append(name)
    # 期号/标题残留（跨期复用风险）：形如 005 / 第5期 的具体期号不应出现在通用图示提示词
    episode_residue = re.findall(r"(?:episode\s*/?\s*:?\s*\d{2,4}|\b\d{3}\s*/)", text)
    if episode_residue:
        warnings.append("提示词疑似残留具体期号：" + "、".join(episode_residue[:3]))
    if re.search(r"real\s+terminal|screenshot of (?:a )?(?:terminal|console)", lowered):
        warnings.append("真实程序输出不能用生图替代，应走实截图位")
    passed = not missing
    score = round(sum(checks.values()) / len(checks) * 25)
    return {"passed": passed, "missing": missing, "warnings": warnings,
            "checks": checks, "score_25": score,
            "note": "lint 只帮助编辑，不保证生图工具实际输出"}


def save_prompt_revision(store, account_id: str, job_id: str, figure_no: int,
                         prompt_text: str, *, origin: str = "agent") -> dict[str, Any]:
    origin = origin if origin in ("agent", "user", "system") else "agent"
    row = store.conn.execute(
        "SELECT MAX(version) AS v FROM prompt_revisions WHERE account_id=? AND job_id=?"
        " AND figure_no=?", (account_id, job_id, figure_no)).fetchone()
    version = (row["v"] or 0) + 1
    prompt_hash = sha256(prompt_text.encode("utf-8")).hexdigest()
    lint = lint_prompt(prompt_text)
    revision_id = new_id("prev")
    with store.transaction():
        store.conn.execute(
            "INSERT INTO prompt_revisions (revision_id, account_id, job_id, figure_no,"
            " version, origin, prompt_text, prompt_hash, lint_json, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (revision_id, account_id, job_id, figure_no, version, origin,
             prompt_text, prompt_hash, json.dumps(lint, ensure_ascii=False), now_iso()))
    return {"revision_id": revision_id, "version": version, "origin": origin,
            "prompt_hash": prompt_hash, "lint": lint}


def list_prompt_revisions(store, account_id: str, job_id: str,
                          figure_no: int | None = None) -> list[dict[str, Any]]:
    if figure_no is None:
        rows = store.conn.execute(
            "SELECT revision_id, figure_no, version, origin, prompt_hash, lint_json,"
            " created_at FROM prompt_revisions WHERE account_id=? AND job_id=?"
            " ORDER BY figure_no, version", (account_id, job_id)).fetchall()
    else:
        rows = store.conn.execute(
            "SELECT revision_id, figure_no, version, origin, prompt_hash, lint_json,"
            " created_at FROM prompt_revisions WHERE account_id=? AND job_id=?"
            " AND figure_no=? ORDER BY version", (account_id, job_id, figure_no)).fetchall()
    return [dict(row) for row in rows]


# ------------------------------------------------------------- 图位-Run 绑定
def bind_slot_run(store, account_id: str, job_id: str, figure_no: int, run_id: str,
                  source_hash: str, *, input_hash: str = "",
                  expected_result_kind: str = "success",
                  approved_error: bool = False,
                  bound_by: str = "user") -> dict[str, Any]:
    if expected_result_kind not in ("success", "expected_error"):
        raise ValueError("结果类型只能是 success 或 expected_error")
    if expected_result_kind == "expected_error" and not approved_error:
        raise ValueError("预期错误素材必须显式批准后才能绑定图位")
    binding_id = new_id("bind")
    with store.transaction():
        # 运行记录在 checkpoint state（v1.5.3 结构），不在 jobs 表。
        row = store.conn.execute(
            "SELECT state_json FROM checkpoints WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise ValueError("任务不存在或尚无检查点")
        runs = json.loads(row["state_json"]).get("runs") or {}
        record = runs.get(run_id)
        if not record:
            raise ValueError("运行记录不存在于该任务")
        if record.get("code_sha256", "")[:len(source_hash)] != source_hash:
            raise ValueError("源码 hash 与运行记录不符，拒绝绑定")
        store.conn.execute(
            "INSERT INTO slot_run_bindings (binding_id, account_id, job_id, figure_no,"
            " run_id, source_hash, input_hash, expected_result_kind, approved_error,"
            " bound_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(account_id, job_id, figure_no) DO UPDATE SET"
            " run_id=excluded.run_id, source_hash=excluded.source_hash,"
            " input_hash=excluded.input_hash,"
            " expected_result_kind=excluded.expected_result_kind,"
            " approved_error=excluded.approved_error, bound_by=excluded.bound_by",
            (binding_id, account_id, job_id, figure_no, run_id, source_hash,
             input_hash, expected_result_kind, int(approved_error), bound_by, now_iso()))
    return {"binding_id": binding_id, "figure_no": figure_no, "run_id": run_id,
            "expected_result_kind": expected_result_kind}


def record_capture(store, account_id: str, job_id: str, figure_no: int, *,
                   candidate_id: str, resource_id: str, file_sha256: str,
                   capture_hash: str, runs: list[dict[str, Any]],
                   automatic: bool = False) -> dict[str, Any]:
    """C2：把一次运行截图登记为领域资产，留账户/任务/图位/运行/源码 hash。"""
    capture_id = new_id("cap")
    run_ids = [str(run.get("run_id", "")) for run in runs]
    source_hashes = [str(run.get("code_sha256", "")) for run in runs]
    with store.transaction():
        store.conn.execute(
            "INSERT INTO capture_assets (capture_id, account_id, job_id, figure_no,"
            " candidate_id, resource_id, file_sha256, capture_hash, run_ids,"
            " source_hashes, automatic, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (capture_id, account_id, job_id, figure_no, candidate_id, resource_id,
             file_sha256, capture_hash, json.dumps(run_ids, ensure_ascii=False),
             json.dumps(source_hashes, ensure_ascii=False), int(automatic), now_iso()))
    return {"capture_id": capture_id, "resource_id": resource_id}


def capture_status(store, account_id: str, job_id: str, figure_no: int,
                   current_runs: dict[str, Any] | None) -> dict[str, Any] | None:
    """截图绑定的运行证据是否仍有效：运行被替换、源码 hash 变化或记录消失即失效。"""
    row = store.conn.execute(
        "SELECT * FROM capture_assets WHERE account_id=? AND job_id=? AND figure_no=?"
        " ORDER BY created_at DESC LIMIT 1", (account_id, job_id, figure_no)).fetchone()
    if not row:
        return None
    run_ids = json.loads(row["run_ids"])
    source_hashes = json.loads(row["source_hashes"])
    current = current_runs or {}
    stale_runs = [run_id for run_id, source_hash in zip(run_ids, source_hashes)
                  if not current.get(run_id)
                  or current[run_id].get("code_sha256") != source_hash]
    return {"capture_id": row["capture_id"], "resource_id": row["resource_id"],
            "candidate_id": row["candidate_id"], "file_sha256": row["file_sha256"],
            "capture_hash": row["capture_hash"], "run_ids": run_ids,
            "created_at": row["created_at"], "automatic": bool(row["automatic"]),
            "stale": bool(stale_runs), "stale_runs": stale_runs}


def slot_run_binding(store, account_id: str, job_id: str, figure_no: int) -> dict[str, Any] | None:
    row = store.conn.execute(
        "SELECT * FROM slot_run_bindings WHERE account_id=? AND job_id=? AND figure_no=?",
        (account_id, job_id, figure_no)).fetchone()
    return dict(row) if row else None


# ------------------------------------------------------------- 下载待归档
_ALLOWED_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                  ".webp": "image/webp"}


MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024
DOWNLOAD_READ_CHUNK = 1024 * 1024


def _download_metadata(path: Path) -> tuple[str, int, str]:
    """Validate and hash one open file with bounded buffers, never read_bytes()."""
    if not path.is_file():
        raise ValueError("下载文件不存在")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("只接受普通图片文件")
        if before.st_size > MAX_DOWNLOAD_BYTES:
            raise ValueError("下载图片超过 32MB，请压缩后重新导入")
        raw = stream.read(32)
        if len(raw) < 8:
            raise ValueError("文件过小，不像有效图片")
        mime = _ALLOWED_MEDIA.get(path.suffix.lower(), "")
        if mime == "image/png" and raw[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("扩展名与文件内容不符（PNG magic 缺失）")
        if mime == "image/jpeg" and raw[:2] != b"\xff\xd8":
            raise ValueError("扩展名与文件内容不符（JPEG magic 缺失）")
        if mime == "image/webp" and not (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
            raise ValueError("扩展名与文件内容不符（WebP magic 缺失）")
        if not mime:
            raise ValueError("只接受 png/jpg/webp 下载归档")
        digest = sha256(raw)
        size = len(raw)
        while chunk := stream.read(DOWNLOAD_READ_CHUNK):
            size += len(chunk)
            if size > MAX_DOWNLOAD_BYTES:
                raise ValueError("下载图片超过 32MB，请压缩后重新导入")
            digest.update(chunk)
        after = os.fstat(stream.fileno())
        if size != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("下载文件在读取时发生变化，请重新导入")
        return mime, size, digest.hexdigest()


def stage_download(store, account_id: str, file_path: str, *,
                   origin_url: str = "") -> dict[str, Any]:
    """下载进待归档箱：有界 MIME/hash 校验，不确定图位前不生成就绪候选。"""
    path = Path(file_path)
    mime, size, file_hash = _download_metadata(path)
    download_id = new_id("dl")
    with store.transaction():
        dup = store.conn.execute(
            "SELECT download_id, status, bound_slot FROM download_staging"
            " WHERE account_id=? AND file_sha256=?", (account_id, file_hash)).fetchone()
        if dup:
            return {"download_id": dup["download_id"], "deduped": True,
                    "status": dup["status"], "bound_slot": dup["bound_slot"]}
        store.conn.execute(
            "INSERT INTO download_staging (download_id, account_id, file_path, file_sha256,"
            " mime, size, origin_url, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (download_id, account_id, str(path), file_hash, mime, size,
             origin_url[:300], "pending", now_iso()))
    return {"download_id": download_id, "deduped": False, "status": "pending",
            "mime": mime, "size": size, "file_sha256": file_hash}


def bind_download(store, runtime, account_id: str, download_id: str,
                  slot_label: str | None,
                  *, job_id: str | None = None, figure_no: int | None = None) -> dict[str, Any]:
    """R10 批次四：绑定必须落到真实图位并导入正式资源/候选，不能只写自由 label。

    - slot_label=None → 用户判定不属于任何图位 → 丢弃（不产生就绪候选）。
    - 提供(job_id, figure_no)时校验图位存在，并把文件经 WorkspaceAssets 导入
      为正式资源 + 候选 + 采纳（走与手动导入同一领域链）。
    """
    row = store.conn.execute(
        "SELECT * FROM download_staging WHERE download_id=? AND account_id=?",
        (download_id, account_id)).fetchone()
    if not row:
        raise ValueError("下载记录不存在或不属于当前公众号")
    if row["status"] == "discarded":
        raise ValueError("已丢弃的下载不能绑定")
    bound_slot = None
    if slot_label is not None:
        if not job_id or not isinstance(figure_no, int):
            raise ValueError("绑定图位需要任务与图位编号；自由文本标签不能成为就绪候选")
        source = Path(row["file_path"])
        if not source.is_file():
            raise ValueError("下载的源文件已不存在，无法导入")
        slot_id = find_slot_for_figure(store, job_id, figure_no)
        if not slot_id:
            raise ValueError("该文章没有对应编号的图位")
        # 走与手动导入同一领域链：正式资源 + 候选 + 采纳（upsert_slot 记录 selected_candidate，
        # selected_asset 在导出/截图时再次做 hash/审核校验）。
        from .workspace_assets import WorkspaceAssets
        box = WorkspaceAssets(store, runtime, account_id)
        imported = box.import_image(source)
        imported.update(title=f"下载导入 · 图{figure_no}",
                        tags=["下载归档"], usage="body_real" if figure_no > 1 else "cover")
        box.save_resource(imported)
        candidate_id = f"cand-{uuid.uuid4().hex[:20]}"
        store.add_candidate({
            "candidate_id": candidate_id, "slot_id": slot_id, "source": "download",
            "file_path": imported["file_path"], "sha256": row["file_sha256"],
            "review_status": "accepted", "created_at": now_iso(),
        })
        slot = store.conn.execute(
            "SELECT slot_json FROM asset_slots WHERE slot_id=?", (slot_id,)).fetchone()
        slot_data = json.loads(slot["slot_json"])
        slot_data["selected_candidate"] = candidate_id
        store.upsert_slot(slot_data)
        bound_slot = f"{job_id}#fig{figure_no}"
    store.conn.execute(
        "UPDATE download_staging SET status=?, bound_slot=?, decided_at=? WHERE download_id=?",
        ("bound" if slot_label else "discarded", bound_slot, now_iso(), download_id))
    store.conn.commit()
    return {"download_id": download_id, "status": "bound" if slot_label else "discarded",
            "bound_slot": bound_slot}


def staging_list(store, account_id: str) -> list[dict[str, Any]]:
    rows = store.conn.execute(
        "SELECT download_id, file_path, file_sha256, mime, size, status, bound_slot,"
        " created_at FROM download_staging WHERE account_id=?"
        " ORDER BY created_at DESC LIMIT 100", (account_id,)).fetchall()
    return [dict(row) for row in rows]
