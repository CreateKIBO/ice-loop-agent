"""测试基建：临时目录一律放在仓库内（不落 C 盘）。"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

# v3（C-03）桌面工作台默认退场代码执行。既有 v1/v2 回归套件验证的是历史执行链，
# 因此在源码测试中显式打开兼容开关；v3 测试用 legacy_execution(False) 验证默认退场。
os.environ.setdefault("ICE_LEGACY_CODE_EXECUTION", "1")

REPO = Path(__file__).resolve().parent.parent
TEST_TMP = REPO / ".test-tmp"


def temp_dir(prefix: str = "t") -> Path:
    TEST_TMP.mkdir(exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(TEST_TMP)))


def cleanup_all() -> None:
    if TEST_TMP.exists():
        shutil.rmtree(TEST_TMP, ignore_errors=True)


def load_profile() -> dict:
    import json
    return json.loads(
        (REPO / "profiles" / "ice-loop.json").read_text(encoding="utf-8"))
