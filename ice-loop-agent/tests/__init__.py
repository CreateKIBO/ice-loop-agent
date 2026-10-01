"""测试基建：临时目录一律放在仓库内（不落 C 盘）。"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

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
