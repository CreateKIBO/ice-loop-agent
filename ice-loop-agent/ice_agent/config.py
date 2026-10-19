"""配置加载：规则 profile 与运行时配置。

- 规则 profile（profiles/ice-loop.json）为设计文档 §3.3 YAML 契约的 JSON 实现，
  非秘密、随源码版本化。
- 模型凭据只从环境变量读取（Mimosa 安全约束 + §20.2），配置文件里只存
  环境变量名 ``api_key_env``，绝不落明文 Key。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .paths import ensure_dir, normalize

_DEFAULT_PROFILE = Path(__file__).resolve().parent.parent / "profiles" / "ice-loop.json"
if not _DEFAULT_PROFILE.exists():
    _DEFAULT_PROFILE = Path(__file__).resolve().parent / "resources" / "ice-loop.json"


@dataclass
class RuntimeConfig:
    """引擎运行时配置（一次任务运行内的只读快照）。"""

    article_root: Path
    runtime_root: Path
    profile: dict[str, Any]
    profile_path: Path
    db_path: Path = field(init=False)

    def __post_init__(self) -> None:
        self.article_root = normalize(self.article_root)
        self.runtime_root = normalize(self.runtime_root)
        from .paths import assert_not_c_drive
        assert_not_c_drive(self.article_root)
        assert_not_c_drive(self.runtime_root)
        self.db_path = self.runtime_root / "app.db"
        ensure_dir(self.runtime_root)
        ensure_dir(self.runtime_root / "jobs")
        ensure_dir(self.runtime_root / "logs")
        ensure_dir(self.runtime_root / "staging")

    # ---- 规则便捷访问 -------------------------------------------------
    @property
    def article_rules(self) -> dict[str, Any]:
        return self.profile["article"]

    def series_name(self, code: str) -> str:
        info = self.profile.get("series", {}).get(code)
        return info["name"] if info else code

    def job_dir(self, job_id: str) -> Path:
        from .paths import assert_within
        directory = self.runtime_root / "jobs" / job_id
        assert_within(directory, self.runtime_root / "jobs")
        return ensure_dir(directory)


def load_profile(path: str | Path | None = None) -> dict[str, Any]:
    p = normalize(path) if path else _DEFAULT_PROFILE
    if not p.exists():
        raise FileNotFoundError(f"规则 profile 不存在：{p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("profile") != "ice-loop":
        raise ValueError(f"未知 profile：{data.get('profile')}")
    return data


def resolve_credential(env_name: str) -> str | None:
    """只从环境变量读取凭据；不存在返回 None，绝不接受字面量。"""
    value = os.environ.get(env_name, "").strip()
    return value or None


def make_runtime_config(
    article_root: str | Path | None = None,
    runtime_root: str | Path | None = None,
    profile_path: str | Path | None = None,
) -> RuntimeConfig:
    profile_file = normalize(profile_path) if profile_path else _DEFAULT_PROFILE
    profile = load_profile(profile_file)
    storage = profile.get("storage", {})
    # Explicit caller paths retain their normal cwd semantics. Paths declared
    # by a profile belong to that profile, so moving the project or launching
    # from another working directory cannot select a different data workspace.
    def configured_path(explicit, key):
        if explicit is not None:
            return explicit
        value = storage.get(key)
        if value:
            path = Path(value).expanduser()
            return path if path.is_absolute() else profile_file.parent / path
        return None
    art = configured_path(article_root, "article_root_win")
    run = configured_path(runtime_root, "runtime_root_win")
    if not art or not run:
        raise ValueError("article_root 与 runtime_root 必须显式给定或存在于 profile")
    return RuntimeConfig(
        article_root=Path(art), runtime_root=Path(run), profile=profile,
        profile_path=profile_file,
    )
