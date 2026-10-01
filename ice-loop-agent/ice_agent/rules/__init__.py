"""ice_agent.rules — 结构/品牌/事实三层规则引擎。"""
from __future__ import annotations

from typing import Any

from .brand import check_brand, check_l1_quiet
from .facts import check_facts, scan_high_risk
from .markdown_ast import ArticleAST, parse_markdown
from .structural import RuleReport, check_structure, check_title_and_abstract

__all__ = [
    "ArticleAST", "parse_markdown", "RuleReport",
    "check_structure", "check_title_and_abstract",
    "check_brand", "check_l1_quiet", "check_facts", "scan_high_risk",
    "run_all_checks",
]


def run_all_checks(
    markdown: str,
    profile: dict[str, Any],
    *,
    series: str = "",
    title: str | None = None,
    abstract: str = "",
    claims: list[dict] | None = None,
    target_words: tuple[int, int] | None = None,
    publish_day_check: bool = False,
) -> dict[str, Any]:
    """对一篇正文跑全部程序化检查，返回合并报告（§21.3 就绪检查的程序部分）。"""
    ast = parse_markdown(markdown)
    title = title if title is not None else (ast.h1().text if ast.h1() else "")
    structure = check_structure(ast, profile, target_words)
    tna = check_title_and_abstract(title, abstract, profile)
    brand = check_brand(ast, profile, series)
    brand_title = check_l1_quiet(title, profile)
    facts = check_facts(ast, claims or [], series, publish_day_check)

    merged = RuleReport()
    for rpt in (structure, tna, brand, brand_title, facts):
        merged.findings.extend(rpt.findings)
    return {
        "passed": merged.passed,
        "visible_chars": ast.visible_chars(),
        "code_blocks": len(ast.code_blocks()),
        "figures": len(ast.image_placeholders()),
        "report": merged.to_dict(),
    }
