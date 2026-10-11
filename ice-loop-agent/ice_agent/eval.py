"""离线规则评测（M8-05，报告 §15.3/§18.2）。

固定脱敏样例（正/负），覆盖：规则通过、结构缺项、品牌禁词、IR 损坏回退、
运行引用缺失。不触发真实模型或外部网络；结果 JSON + 退出码用于回归。

用法：python -m ice_agent.eval [--json 路径]；exit 0=全部预期通过。
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import __version__
from .editorial import accept_model_draft
from .llm.mockgen import generate_structured
from .rules import run_all_checks

# 规则 fixture 用真实 ICE Loop 规则文件（脱敏、随包分发），避免两份口径漂移。
import json as _json
from pathlib import Path as _Path
_RULES_PATH = _Path(__file__).parent / "resources" / "ice-loop.json"
ICE_PROFILE: dict[str, Any] = _json.loads(_RULES_PATH.read_text(encoding="utf-8"))

GOOD_ARTICLE = """# for 和 while：让电脑替你重复干活

循环就是让电脑替你重复干活，九九乘法表是经典练习。

## 一、先看一个循环

```python
# 打印乘法表的行：range 生成 1 到 9
# 逐行输出，先看清结构再谈优化
for row in range(1, 10):
    print(row)
```

![图1：循环氛围示意](待配图：氛围｜由品牌封面模板改字)

## 写在最后

**ICE 循环回顾**：确定重复→写成循环→检查边界，本期走了完整一遍。
**下期预告**：while 循环与停止条件（下期公布本期动手题参考答案）。
动手环节：把乘法表打满九行。欢迎把运行结果发到后台交流，也欢迎关注追更。
**可执行的想象，从第一行代码开始。**
"""

MISSING_ENDING = """# 缺结尾的文章

只有一段正文，没有写在最后章节。
"""

BANNED_WORD = """# 全网最强的入门指南

这篇文章是保姆级教程。

## 写在最后

结束。**可执行的想象，从第一行代码开始。**
"""

RUN_REF_MISSING = """# 引用不存在的运行输出

## 一、示例

<!--RUN_OUTPUT:run-does-not-exist-->

## 写在最后

结束。**可执行的想象，从第一行代码开始。**
"""


def _sample_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = [
        {"id": "good_article_passes", "kind": "rules",
         "expect": "passed", "markdown": GOOD_ARTICLE},
        {"id": "missing_ending_blocked", "kind": "rules",
         "expect": "blocked", "markdown": MISSING_ENDING},
        {"id": "banned_word_blocked", "kind": "rules",
         "expect": "blocked", "markdown": BANNED_WORD},
        {"id": "ir_broken_falls_back_to_markdown", "kind": "ir",
         "expect": "fallback", "text": '```json\n{"ir_version": 1, "title": "", "blocks": []}\n```'},
        {"id": "ir_valid_converts", "kind": "ir",
         "expect": "converted",
         "text": '```json\n{"ir_version": 1, "title": "IR 文章", '
                 '"blocks": [{"type": "paragraph", "text": "正文"}]}\n```'},
        {"id": "mock_topic_structured", "kind": "mock",
         "expect": "structured", "node": "topic"},
    ]
    # 运行引用：编辑器文档化后由 evidence_errors 把关（保持既有行为断言）
    from .workflow.nodes import evidence_errors
    missing_refs = evidence_errors(RUN_REF_MISSING, {})
    cases.append({"id": "run_ref_missing_reported", "kind": "evidence",
                  "expect": "flagged", "flagged": bool(missing_refs)})
    return cases


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ICE Loop 离线规则评测")
    parser.add_argument("--json", dest="json_path", default="", help="结果 JSON 输出路径")
    args = parser.parse_args(argv)

    results: list[dict[str, Any]] = []
    ok = True
    for case in _sample_cases():
        passed = False
        detail: dict[str, Any] = {}
        try:
            if case["kind"] == "rules":
                report = run_all_checks(case["markdown"], ICE_PROFILE)
                passed = (report["passed"] is True) if case["expect"] == "passed" \
                    else (report["passed"] is False)
                detail = {"passed_all": report["passed"],
                          "findings": len(report["report"].get("findings", []))}
            elif case["kind"] == "ir":
                markdown, used = accept_model_draft(case["text"])
                if case["expect"] == "fallback":
                    passed = used is False and markdown == case["text"].strip()
                else:
                    passed = used is True and markdown.startswith("# IR 文章")
            elif case["kind"] == "evidence":
                passed = bool(case["flagged"]) if case["expect"] == "flagged" else not case["flagged"]
            elif case["kind"] == "mock":
                data = generate_structured(case["node"], {})
                passed = isinstance(data, dict) and bool(data)
                detail = {"keys": sorted(data)[:6]}
        except Exception as exc:  # 样例自身异常按失败计，不中断整批
            detail = {"exception": f"{type(exc).__name__}: {exc}"[:300]}
        if not passed:
            ok = False
        results.append({"id": case["id"], "kind": case["kind"],
                        "expect": case["expect"], "passed": passed, **detail})
    summary = {"suite": "ice-agent offline eval", "app_version": __version__,
               "total": len(results),
               "failed": sum(1 for r in results if not r["passed"]),
               "cases": results}
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.json_path:
        from pathlib import Path
        Path(args.json_path).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
