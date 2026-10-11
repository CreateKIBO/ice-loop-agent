"""工作流依赖失效映射与批量队列支撑（M6-02/M6-04，报告 §12.2）。

失效映射是确定性的解释工具：改动类型 → 受影响节点集合；不重跑不在
集合内的节点。节点 cache key 的既有实现（steps.input_hash）不变。
"""
from __future__ import annotations

from typing import Any

# 改动 → 受影响节点（依赖 hash 语义，报告 §12.2 表格的代码化）。
INVALIDATION_MAP: dict[str, tuple[str, ...]] = {
    "title": ("title_workshop", "asset_plan", "export"),
    "body": ("article_review", "style_review", "integrate_evidence", "export"),
    "code": ("verify_code", "integrate_evidence", "article_review"),
    "asset": ("assets", "final_check", "export"),
    "rules": ("article_review", "style_review"),
    "outline": ("draft", "verify_code", "article_review", "asset_plan"),
}

KNOWN_CHANGES = frozenset(INVALIDATION_MAP)


def invalidation_preview(changes: list[str]) -> dict[str, Any]:
    """给定改动集合，返回需要重跑与保留的节点集合（含原因映射）。"""
    reasons: dict[str, list[str]] = {}
    for change in changes:
        if change not in KNOWN_CHANGES:
            raise ValueError("未知改动类型：" + str(change))
        for node in INVALIDATION_MAP[change]:
            reasons.setdefault(node, []).append(change)
    stale = sorted(reasons)
    keep = sorted(set(NODE_ORDER) - set(stale))
    return {"stale_nodes": stale, "keep_nodes": keep,
            "reasons": reasons,
            "note": "改标题不重跑程序执行；改代码使其执行证据与相关审校失效"}


NODE_ORDER: tuple[str, ...] = (
    "ingest", "topic", "research", "outline", "draft", "verify_code",
    "integrate_evidence", "article_review", "style_review", "title_workshop",
    "asset_plan", "assets", "final_check", "export",
)


def batch_plan(article_specs: list[dict[str, Any]], *, max_concurrency: int) -> dict[str, Any]:
    """多期批量计划（M6-04）：逐篇预算保留、并发上限、前篇依赖。

    每篇一个 production 任务（幂等键 = 文章+revision），依赖篇顺序：
    前篇未完成时后篇 priority 降低（排队但不并发）。
    """
    if not 1 <= max_concurrency <= 8:
        raise ValueError("并发上限需为1–8")
    tasks = []
    for index, spec in enumerate(article_specs[:50]):
        article_id = spec.get("article_id")
        if not article_id:
            raise ValueError("批量计划缺少 article_id")
        tasks.append({
            "article_id": article_id,
            "task_id_ref": f"production:{article_id}:{spec.get('revision', 'current')}",
            "priority": 5 if index < max_concurrency else 6,
            "depends_on": article_specs[index - 1]["article_id"] if index > 0 else None,
            "budget_calls": int(spec.get("budget_calls", 30)),
        })
    return {"tasks": tasks, "max_concurrency": max_concurrency,
            "note": "逐篇预算独立；前篇依赖显式声明，暂停单项不冻结队列"}
