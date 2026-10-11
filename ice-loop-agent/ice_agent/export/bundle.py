"""交付导出（M9-01/02/03，报告 §17）：文本/图片两目录 + manifest + staging 提交。

v2.1 修订（R05/R06/R13）：
- 图片一律来自领域 ``selected_asset`` 解析结果（handler 传入已核验 figures），
  不再信任渲染层拼接的 ``slot.candidate`` 形状；来源必须属于当前文章/账号。
- PNG/JPEG/WebP 按 MIME 选扩展名，原字节复制不重压缩。
- 正文经文档模型重写：仅 image_slot 块替换为 ../图片/ 相对引用；代码块是
  独立块，不受替换影响（无需正文正则）。
- ready 模式由 handler 执行统一就绪校验（规则/事实/审批/运行证据），本模块
  只接收 allow_ready/blocking 结论并阻断，防止仅"文件存在"放行。
- staging：UUID + owner token + (st_dev,st_ino) 身份；只清本调用创建且身份
  仍一致的目录（R01 已修，保留）。
"""
from __future__ import annotations

import json
import shutil
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..domain.types import now_iso
from ..editorial import parse_document
from ..domain.types import sha256_text
from ..paths import assert_not_c_drive

TXT_NAME = "02-公众号正文.txt"
MD_NAME = "01-公众号正文.md"

MIME_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


class ExportBlocked(ValueError):
    """发布就绪包被统一校验阻断；blocking 列出全部原因。"""


def _assert_no_links(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink() or item.is_junction():
            raise PermissionError("导出路径不能经过符号链接或目录联接")


def _cleanup_owned_staging(staging: Path, parent: Path, token: str,
                           identity: tuple[int, int]) -> None:
    """Never remove a directory that this invocation failed to create or lost."""
    try:
        _assert_no_links(staging)
        if staging.resolve().parent != parent:
            return
        stat = staging.stat()
        if (stat.st_dev, stat.st_ino) != identity:
            return
        marker = staging / ".ice-export-owner"
        if marker.is_symlink() or marker.read_text(encoding="ascii") != token:
            return
        # Refuse linked descendants rather than following them during deletion.
        for item in staging.rglob("*"):
            if item.is_symlink() or item.is_junction():
                return
        shutil.rmtree(staging)
    except (OSError, PermissionError, ValueError):
        # Uncertain ownership or a lock: preserve the directory for inspection.
        return


def plain_text_from_markdown(markdown: str) -> str:
    """Markdown → 纯文本：标题去井号、代码块原样保留、图片占位转为说明行。

    用文档模型而非全文正则——代码内容与占位符语义不丢。
    """
    lines: list[str] = []
    for block in parse_document(markdown)["blocks"]:
        kind = block["type"]
        if kind == "heading":
            lines.append(block["text"])
            lines.append("")
        elif kind == "paragraph":
            lines.append(block["text"])
            lines.append("")
        elif kind == "code":
            lines.extend(block["lines"])
            lines.append("")
        elif kind == "image_slot":
            lines.append(f"[图{block['figure_no']}：{block['caption']}——待配图：{block['kind']}｜{block.get('obtain', '')}]")
            lines.append("")
        elif kind == "image":
            lines.append("[图片]" + block["source"])
            lines.append("")
        elif kind == "run_output":
            lines.append(f"[运行输出 {block['run_ref']}]")
            lines.append("")
        elif kind == "quote":
            lines.append(block["text"])
            lines.append("")
        elif kind == "list":
            lines.extend(block.get("items") or [])
            lines.append("")
        elif kind == "hr":
            lines.append("———")
            lines.append("")
        else:
            lines.append(block.get("text") or block.get("source") or "")
            lines.append("")
    return "\n".join(lines).strip() + "\n"


def plain_text_with_images(markdown: str, figure_names: dict[int, str]) -> str:
    """导出 TXT：图位替换为指向 图片/ 的说明行；代码原样。"""
    lines: list[str] = []
    for block in parse_document(markdown)["blocks"]:
        kind = block["type"]
        if kind == "heading":
            lines.append(block["text"])
            lines.append("")
        elif kind == "paragraph":
            lines.append(block["text"])
            lines.append("")
        elif kind == "code":
            lines.extend(block["lines"])
            lines.append("")
        elif kind == "image_slot":
            name = figure_names.get(int(block["figure_no"]))
            if name:
                lines.append(f"[图{block['figure_no']}：{block['caption']}——见 图片/{name}]")
            else:
                lines.append(f"[图{block['figure_no']}：{block['caption']}——待配图：{block['kind']}｜{block.get('obtain', '')}]")
            lines.append("")
        elif kind == "image":
            lines.append("[图片]" + block["source"])
            lines.append("")
        elif kind == "run_output":
            lines.append(f"[运行输出 {block['run_ref']}]")
            lines.append("")
        elif kind == "quote":
            lines.append(block["text"])
            lines.append("")
        elif kind == "list":
            lines.extend(block.get("items") or [])
            lines.append("")
        elif kind == "hr":
            lines.append("———")
            lines.append("")
        else:
            lines.append(block.get("text") or block.get("source") or "")
            lines.append("")
    return "\n".join(lines).strip() + "\n"


def export_markdown_with_images(markdown: str, figure_names: dict[int, str]) -> str:
    """仅把 image_slot 块改写为 ../图片/ 相对引用；其他块字节保真。

    文档模型保证代码块/引用是独立块，图位替换不会波及演示代码。
    """
    blocks = []
    for block in parse_document(markdown)["blocks"]:
        if block["type"] == "image_slot":
            figure_no = int(block["figure_no"])
            name = figure_names.get(figure_no)
            if name:
                relative = "../图片/" + name
                line = f"![图{figure_no}：{block['caption']}]({relative})"
                blocks.append({"block_id": block["block_id"], "type": "paragraph",
                               "text": line, "source": line})
                continue
        blocks.append(block)
    document = {"schema_version": 1, "blocks": blocks}
    from ..editorial import serialize_document
    return serialize_document(document)


def export_bundle(*, job_id: str, title: str, body: str, content_hash: str,
                  figures: list[dict[str, Any]] | None = None, runs: dict[str, Any],
                  run_refs_status: dict[str, dict[str, Any]] | None = None,
                  allow_ready: bool = False, blocking: list[str] | None = None,
                  destination: Path, include_manifest: bool = True,
                  mode: str = "draft",
                  revision_id: str = "", asset_set_hash: str = "",
                  slots: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if figures is None:
        # 兼容 Codex 所有权回归（R01）旧签名：slots=[] 表示未解析图片，
        # 这些用例只验证 staging 所有权，不进入图片导出路径。
        figures = []
    if run_refs_status is None:
        run_refs_status = {}
    if blocking is None:
        blocking = []
    destination = Path(destination)
    if not destination.is_absolute():
        raise ValueError("导出目录必须使用绝对路径（请通过界面目录选择器获取）")
    assert_not_c_drive(destination)
    _assert_no_links(destination)
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("导出目录已存在；为避免覆盖请使用新的导出目录")
    if mode not in ("draft", "ready"):
        raise ValueError("导出模式只能是 draft 或 ready")
    if mode == "ready" and (not allow_ready or blocking):
        raise ExportBlocked("发布就绪包未通过统一校验：" + "；".join(blocking))
    token = uuid4().hex
    staging = destination.parent / (destination.name + "-staging-" + token)
    identity: tuple[int, int] | None = None
    checks: dict[str, Any] = {"missing_images": [], "pending_placeholders": 0,
                              "run_refs_unresolved": [], "blocking": list(blocking)}
    doc = parse_document(body)
    figure_names: dict[int, str] = {}
    for figure in figures:
        source = Path(figure["path"])
        if not source.is_file():
            checks["missing_images"].append(figure["figure_no"])
            continue
        suffix = MIME_SUFFIX.get(figure["mime"])
        if not suffix:
            checks["missing_images"].append(figure["figure_no"])
            continue
        figure_names[int(figure["figure_no"])] = f"{figure['order']:02d}-{figure['figure_no']:02d}{suffix}"
    for block in doc["blocks"]:
        if block["type"] == "image_slot" and int(block["figure_no"]) not in figure_names:
            checks["pending_placeholders"] += 1
            if block["figure_no"] not in checks["missing_images"]:
                checks["missing_images"].append(block["figure_no"])
        if block["type"] == "run_output":
            ref = block["run_ref"]
            status = run_refs_status.get(ref)
            if not status or not status.get("ok"):
                checks["run_refs_unresolved"].append(ref)
    if mode == "ready" and (checks["missing_images"] or checks["pending_placeholders"]
                            or checks["run_refs_unresolved"]):
        raise ExportBlocked("发布就绪包存在阻断项：" + json.dumps(checks, ensure_ascii=False))
    exported_markdown = export_markdown_with_images(body, figure_names)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        _assert_no_links(destination.parent)
        staging.mkdir()
        stat = staging.stat()
        identity = (stat.st_dev, stat.st_ino)
        (staging / ".ice-export-owner").write_text(token, encoding="ascii")
        text_dir = staging / "文本"
        image_dir = staging / "图片"
        text_dir.mkdir()
        image_dir.mkdir()
        md_target = text_dir / MD_NAME
        md_target.write_text(exported_markdown, encoding="utf-8")
        txt_target = text_dir / TXT_NAME
        txt_target.write_text(plain_text_with_images(body, figure_names), encoding="utf-8")
        # 原字节复制：来源在解析时已通过 selected_asset 的 hash/MIME 校验。
        image_manifest: list[dict[str, Any]] = []
        for figure in figures:
            figure_no = int(figure["figure_no"])
            name = figure_names.get(figure_no)
            if not name:
                continue
            source = Path(figure["path"])
            current_sha = sha256(source.read_bytes()).hexdigest()
            if current_sha != figure["sha256"]:
                raise ValueError(f"图{figure_no}的来源文件在导出期间发生变化，请重新校验后导出")
            target = image_dir / name
            shutil.copyfile(source, target)  # 原图复制，不重压缩
            if _file_sha256(target) != current_sha:
                raise ValueError(f"图{figure_no}复制后校验失败")
            image_manifest.append({
                "figure_no": figure_no, "file": "图片/" + name,
                "mime": figure["mime"], "sha256": current_sha,
                "candidate_id": figure.get("candidate_id", ""),
                "slot_id": figure.get("slot_id", ""),
            })
        manifest = {
            "format": "ice-export-v2", "mode": mode,
            "article_title": title, "body_sha256": content_hash,
            "revision_id": revision_id, "asset_set_hash": asset_set_hash,
            "exported_at": now_iso(),
            "files": _tree_hashes(staging),
            "images": image_manifest,
            "checks": checks,
        }
        if include_manifest:
            (staging / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # staging 核对：清单与实际文件一致才提交（manifest.json 自身不进自校验——
        # 自含 hash 不可能；其余文件逐一核对）。
        written = _tree_hashes(staging)
        non_self = {k: v for k, v in written.items() if k != "manifest.json"}
        if include_manifest and non_self != manifest["files"]:
            raise ValueError("staging 校验失败：清单与实际文件不一致")
        _assert_no_links(staging)
        _assert_no_links(destination)
        if destination.exists():
            raise ValueError("导出目录在提交前已存在，请选择新目录")
        staging.rename(destination)
        (destination / ".ice-export-owner").unlink()
        return {"destination": str(destination), "mode": mode, "checks": checks,
                "images": len(image_manifest),
                "body_sha256": sha256_text(exported_markdown),
                "source_body_sha256": content_hash}
    finally:
        if identity is not None:
            _cleanup_owned_staging(staging, destination.parent, token, identity)


def _file_sha256(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def _tree_hashes(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name != ".ice-export-owner":
            result[path.relative_to(root).as_posix()] = _file_sha256(path)
    return result
