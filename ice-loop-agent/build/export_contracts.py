"""导出权威契约：Pydantic → JSON Schema（desktop/ui/contracts/）。

用法：.venv/Scripts/python.exe -X utf8 -B build/export_contracts.py
前端 TS 类型与预编译 Ajv 由同一批 schema 生成（desktop/ui/scripts/），
因此本脚本输出即合同；tests/test_v2_contracts.py 校验已提交文件与再生结果一致。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from ice_agent.contracts import payload_registry  # noqa: E402

OUT_DIR = REPO / "desktop" / "ui" / "contracts"


def main() -> int:
    from pydantic.json_schema import models_json_schema  # noqa: F401  (import check)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for name, model in sorted(payload_registry().items()):
        schema = model.model_json_schema(ref_template="#/$defs/{model}", mode="validation")
        schema = {"$id": name, "$schema": "https://json-schema.org/draft/2020-12/schema", **schema}
        target = OUT_DIR / f"{name}.schema.json"
        text = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"
        if target.exists() and target.read_text(encoding="utf-8") == text:
            print(f"[export-contracts] unchanged {name}")
        else:
            target.write_text(text, encoding="utf-8")
            print(f"[export-contracts] wrote {name} -> {target.relative_to(REPO)}")
        written += 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
