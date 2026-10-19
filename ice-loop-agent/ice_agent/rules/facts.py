"""事实规则：高风险字段扫描与断言核验状态（§2.6 / §10）。

- 版本号、价格、额度、模型名、性能倍数进入高风险检查；
- 「已核验」必须有来源；未核验的阻断就绪导出（草稿不受阻）；
- 工具/模型类事实默认「发文当天核验」。
"""
from __future__ import annotations

import re
from datetime import datetime

from .markdown_ast import ArticleAST
from .structural import RuleReport


def evidenced_claims(store, article_id: str) -> list[dict]:
    """Load the same persisted evidence for workflow checks and delivery checks."""
    claims=store.article_claims(article_id)
    for claim in claims:
        refs=[store.get_source(source_id) for source_id in claim.get('source_ids',[])]
        claim['evidence_verified']=bool(refs) and all(ref and ref.get('article_id')==article_id
            and ref.get('content_hash') and ref.get('summary') for ref in refs)
    return claims


def claim_verified(claim: dict) -> bool:
    if not (claim.get('status')=='verified' and claim.get('source_ids') and claim.get('verified_at')
            and claim.get('evidence_verified') and claim.get('review_notes')):
        return False
    if claim.get('publish_day_check_required'):
        try:
            return datetime.fromisoformat(claim['verified_at']).astimezone().date()==datetime.now().astimezone().date()
        except (ValueError,TypeError):
            return False
    return True

_HIGH_RISK_PATTERNS: list[tuple[str, str, re.Pattern[str]]] = [
    ("version", "版本号", re.compile(r"[vV]?\d+\.\d+(?:\.\d+)?")),
    ("price", "价格", re.compile(r"[¥$]\s*\d+|(\d+)\s*元|/月|\d+\s*美元")),
    ("quota", "额度", re.compile(r"每月\s*\d+\s*[次条张]|免费额度|\d+\s*次/天")),
    ("model", "模型名", re.compile(
        r"\b(?:GPT-\d|Claude\s*\d|qwen[\w.\-]*|deepseek[\w.\-]*|kimi[\w.\-]*"
        r"|glm-[\w.\-]+|doubao[\w.\-]*|MiniMax[\w.\-]*)\b", re.I)),
    ("performance", "性能倍数", re.compile(r"(?:提升|降低|快|慢)[^。，\n]{0,6}\d+\s*%|\d+\s*倍")),
]

_PUBLISH_DAY_HINT = re.compile(r"当天核验|发文当天|以官网为准")


def scan_high_risk(ast: ArticleAST) -> list[dict[str, str]]:
    """扫描正文（不含代码块）中的高风险字段，返回命中列表。"""
    body = ast.body_text()
    hits: list[dict[str, str]] = []
    for risk, label, pat in _HIGH_RISK_PATTERNS:
        for m in pat.finditer(body):
            ctx = body[max(0, m.start() - 12):m.end() + 12].replace("\n", " ")
            hits.append({"risk_type": risk, "label": label,
                         "text": m.group(0), "context": ctx})
    return hits


def check_facts(ast: ArticleAST, claims: list[dict],
                series: str = "", publish_day_check: bool = False) -> RuleReport:
    """高风险字段与断言状态核对。

    claims 为文章已登记断言（含 status 与 verified_at）；
    publish_day_check=True 表示处于发文当天（当天核验已完成时调用方先更新断言）。
    """
    rpt = RuleReport()
    hits = scan_high_risk(ast)
    verified=claim_verified

    needs_day_check = False
    for h in hits:
        # 命中文本若被某条已核验断言覆盖（互含），视为有证据
        covered = any(h["text"] in c["text"] for c in claims if verified(c))
        if covered:
            continue
        if h["risk_type"] in ("price", "quota", "model", "version"):
            needs_day_check = True
            rpt.add("fact.high_risk", "block",
                    f"{h['label']}「{h['text']}」缺少已核验断言："
                    f"（上下文：…{h['context']}…）需官方来源核验或弱化表述",
                    h["context"])
        else:
            rpt.add("fact.high_risk", "warn",
                    f"{h['label']}「{h['text']}」建议补来源或改成有依据的弱化表述",
                    h["context"])

    unresolved = [c for c in claims
                  if c.get("status") in ("needs_check", "conflict")
                  or (c.get("status") == "verified" and not verified(c))]
    for c in unresolved:
        rpt.add("fact.unresolved_claim", "block",
                f"断言未核验（{c.get('risk_type')}）：{c['text'][:40]}")

    if needs_day_check and not publish_day_check:
        rpt.add("fact.publish_day", "info",
                "存在价格/额度/模型/版本类字段：发文当天需按 02 清单再核验一次"
                "（当天核验完成前不得标记 ready_for_publish）")

    if series == "WK" and _PUBLISH_DAY_HINT.search(ast.body_text()) is None:
        rpt.add("fact.wk_official_note", "info",
                "工具类文章建议在待办/02 中体现「以官网为准 + 发文当天核验」")
    return rpt
