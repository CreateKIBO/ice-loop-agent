"""ice_agent.providers — TapNow 生图通道（手动导入 / 浏览器 / MCP 预留）。"""
from __future__ import annotations

import hashlib
import shutil
import warnings
from pathlib import Path

from ..domain.types import new_id
from ..paths import ensure_dir, normalize, assert_not_c_drive
from ..image_memory import serialized_image_decode

# PNG / JPEG / WebP 魔数（下载校验：HTML 错误页不能冒充图片，§22.1）
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"RIFF", "image/webp"),
)


@serialized_image_decode
def validate_image_file(path: Path) -> tuple[bool, str, int]:
    """返回 (是否有效图片, mime, 大小)。"""
    if not path.is_file() or not 0 < path.stat().st_size <= 32 * 1024 * 1024:
        return False, "", 0
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("图片导入需要 Pillow；请运行项目依赖安装命令") from exc
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                mime = Image.MIME.get(image.format, "")
                if mime not in ("image/png", "image/jpeg", "image/webp") or image.width * image.height > 40_000_000:
                    return False, "", 0
                image.verify()
            with Image.open(path) as image:
                image.load()
            return True, mime, path.stat().st_size
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        pass
    return False, "application/octet-stream", path.stat().st_size


def selected_asset(store, slot: dict) -> dict | None:
    candidate_id = slot.get("selected_candidate")
    if not isinstance(candidate_id, str):
        return None
    candidate = store.get_candidate(candidate_id)
    if not candidate or candidate["slot_id"] != slot["slot_id"] or candidate["review_status"] != "accepted":
        return None
    path = Path(candidate["file_path"])
    try:
        ok, _, _ = validate_image_file(path)
        if ok and hashlib.sha256(path.read_bytes()).hexdigest() == candidate["sha256"]:
            return candidate
    except (OSError, RuntimeError):
        return None
    return None


class ProviderNotConfigured(Exception):
    """通道未完成真实登录/授权前的统一占位错误（§4.2 诚实边界）。"""


class ManualImportProvider:
    """手动导入通道：用户生图/截图后导入，程序做文件校验与登记。"""

    provider_id = "manual_import"

    def __init__(self, asset_root: Path | None = None):
        self.asset_root = asset_root

    def import_asset(self, store, slot: dict, file_path: Path) -> dict:
        ok, mime, size = validate_image_file(file_path)
        if not ok:
            raise ValueError(
                f"导入文件不是有效图片（{file_path.name}，{mime}）；"
                "HTML 错误页或损坏文件不能冒充资产（§22.1）")
        sha = hashlib.sha256(file_path.read_bytes()).hexdigest()
        if self.asset_root is not None:
            root = normalize(self.asset_root)
            assert_not_c_drive(root)
            suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mime]
            managed = ensure_dir(root) / (sha + suffix)
            if not managed.exists():
                shutil.copyfile(file_path, managed)
            if hashlib.sha256(managed.read_bytes()).hexdigest() != sha or not validate_image_file(managed)[0]:
                raise ValueError("图片在归档时发生变化，请重新导入")
            file_path = managed
        candidate = {
            "candidate_id": new_id("cand"), "slot_id": slot["slot_id"],
            "source": "manual_import", "file_path": str(file_path),
            "sha256": sha, "review_status": "pending",
        }
        store.add_candidate(candidate)
        return candidate


class TapNowBrowserProvider:
    """浏览器通道：按 §12.2 十二步流程实现。

    当前版本只完成能力边界声明：自动提交需要用户在 app.tapnow.media
    完成首次登录、并按设计文档验证选择器后才能启用；在此之前所有
    submit 调用都会抛 ProviderNotConfigured，外部操作只允许停留在
    账本 prepared 状态（不会产生重复扣费）。
    """

    provider_id = "tapnow_browser"
    steps = ("open", "ensure_session", "locate_canvas", "prepare_node",
             "attach_reference", "fill_prompt", "configure", "preflight",
             "submit", "monitor", "download", "archive")

    def __init__(self, profile_dir: Path | None = None):
        self.profile_dir = profile_dir

    def submit(self, *args, **kwargs):
        raise ProviderNotConfigured(
            "TapNow 浏览器自动通道尚未完成真实登录验证（设计文档 §12 / M0）；"
            "请使用手动导入通道，或先完成首次登录与选择器验证")


class TapNowMcpProvider:
    """MCP 通道预留：需账号授权与工具 schema 探测后启用（§11）。"""

    provider_id = "tapnow_mcp"
    GATEWAY = "https://mcp.tapnow.media/api/agent-gateway/mcp/general/mcp"

    def discover(self):
        raise ProviderNotConfigured(
            "MCP 通道需要账号授权后探测工具 schema（§11.2）；当前未配置")
