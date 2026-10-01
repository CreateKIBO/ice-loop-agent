"""操作账本（§13）：外部副作用只提交一次，重启后先对账、不盲目重发。

- operation_key = hash(文章、图位、候选序号、提示词、参考图、实际设置、
  账号/团队)；相同参数重试复用旧 key（唯一约束兜底）；
- 状态机：prepared → sending → submitted → running → succeeded /
  failed_confirmed；中断进入 unknown / needs_reconciliation；
- 对账三决策（§13.2）：found_existing / not_submitted / unresolved，
  每个决策都有证据要求，unresolved 保留预算预留；
- 预算按候选次数预留，unknown 不释放。
"""
from __future__ import annotations

from typing import Any

from ..domain.store import Store
from ..domain.types import new_id, now_iso, sha256_json, sha256_text


class LedgerError(Exception):
    pass


class DuplicateSubmitBlocked(LedgerError):
    """同 key 已存在：返回既有操作，不新增派发。"""


class BudgetExceeded(LedgerError):
    pass


class OperationsLedger:
    def __init__(self, store: Store):
        self.store = store

    # ------------------------------------------------------------ key
    @staticmethod
    def compute_operation_key(article_id: str, slot_id: str, candidate_index: int,
                              prompt: str, settings: dict[str, Any],
                              account_ref: str = "") -> str:
        return sha256_json({
            "article": article_id, "slot": slot_id,
            "candidate": candidate_index, "prompt": sha256_text(prompt),
            "settings": settings, "account": account_ref,
        })

    # ---------------------------------------------------------- prepare
    def prepare(self, *, article_id: str, slot_id: str, candidate_index: int,
                provider: str, prompt: str, settings: dict[str, Any],
                max_candidates: int, account_ref: str = "") -> dict[str, Any]:
        with self.store.transaction():
            return self._prepare(article_id=article_id, slot_id=slot_id,
                                 candidate_index=candidate_index, provider=provider,
                                 prompt=prompt, settings=settings,
                                 max_candidates=max_candidates, account_ref=account_ref)

    def _prepare(self, *, article_id, slot_id, candidate_index, provider,
                 prompt, settings, max_candidates, account_ref):
        key = self.compute_operation_key(article_id, slot_id, candidate_index,
                                         prompt, settings, account_ref)
        existing = self.store.find_operation_by_key(key)
        if existing is not None:
            return existing
        ops = [o for o in self.store.article_operations(article_id)
               if o["status"] not in ("not_submitted_confirmed", "failed_confirmed")]
        if len(ops) >= max_candidates:
            raise BudgetExceeded(
                f"预算超限：文章 {article_id} 已有 {len(ops)} 个占用预算的操作，"
                f"上限 {max_candidates}（unknown 操作不释放预算）")
        op = {
            "operation_id": new_id("op"),
            "operation_key": key,
            "article_id": article_id,
            "slot_id": slot_id,
            "candidate_index": candidate_index,
            "provider": provider,
            "prompt_hash": sha256_text(prompt),
            "settings_hash": sha256_json(settings),
            "status": "prepared",
            "provider_task_ref": "",
            "provider_asset_refs": [],
            "reserved_budget": 1,
            "observed_cost": "unknown",
            "error_code": "",
            "created_at": now_iso(),
            "last_checked_at": now_iso(),
            "notes": "",
        }
        self.store.insert_operation(op, commit=False)
        return op

    # ------------------------------------------------------ 发送租约
    def acquire_send_lease(self, operation_id: str) -> dict[str, Any]:
        """prepared → sending（原子取得租约；非 prepared 拒绝）。"""
        op = self.store.get_operation(operation_id)
        if op is None:
            raise LedgerError(f"操作不存在：{operation_id}")
        cursor = self.store.conn.execute(
            "UPDATE operations SET status='sending', last_checked_at=?"
            " WHERE operation_id=? AND status='prepared'", (now_iso(), operation_id))
        self.store.conn.commit()
        if cursor.rowcount != 1:
            raise DuplicateSubmitBlocked(
                f"操作 {operation_id} 状态为 {op['status']}，只有 prepared "
                "可以进入 sending；禁止重复提交")
        return self.store.get_operation(operation_id)

    def mark(self, operation_id: str, status: str, *,
             provider_task_ref: str | None = None,
             provider_asset_refs: list[str] | None = None,
             error_code: str = "", notes: str = "") -> dict[str, Any]:
        fields: dict[str, Any] = {"status": status, "notes": notes}
        if error_code:
            fields["error_code"] = error_code
        if provider_task_ref is not None:
            fields["provider_task_ref"] = provider_task_ref
        if provider_asset_refs is not None:
            fields["provider_asset_refs"] = provider_asset_refs
        self.store.update_operation(operation_id, **fields)
        return self.store.get_operation(operation_id)

    # ------------------------------------------------------------ 对账
    def reconcile(self, operation_id: str, decision: str, evidence: str,
                  *, provider_task_ref: str = "",
                  provider_asset_refs: list[str] | None = None) -> dict[str, Any]:
        """人工/自动对账（§13.2）。决策与证据要求：

        - found_existing：给出可核对的 provider 任务/节点引用与目标参数，
          校验并绑定引用，按实际状态转 submitted/running/succeeded；
        - not_submitted：能证明确实未发出/未被接受的记录，转终态并释放预算；
        - unresolved：证据不足，保持 needs_reconciliation 与预算预留。
        「在画布上没找到」不等于未提交。
        """
        op = self.store.get_operation(operation_id)
        if op is None:
            raise LedgerError(f"操作不存在：{operation_id}")
        if op["status"] not in ("sending", "unknown", "needs_reconciliation"):
            # 幂等：已对账到终态的重复决策直接返回现状
            if op["status"] in ("succeeded", "failed_confirmed",
                                "not_submitted_confirmed"):
                return op
            raise LedgerError(
                f"状态 {op['status']} 不可对账（仅 sending/unknown/"
                "needs_reconciliation）")
        if not evidence.strip():
            raise LedgerError("对账决策必须附带证据说明（§13.2 证据要求）")
        if decision == "found_existing":
            if not provider_task_ref:
                raise LedgerError(
                    "found_existing 需要 provider_task_ref（可核对的账号/画布/"
                    "节点/任务引用）")
            status = "succeeded" if provider_asset_refs else "running"
            self.mark(operation_id, status,
                      provider_task_ref=provider_task_ref,
                      provider_asset_refs=provider_asset_refs,
                      notes=f"对账 found_existing：{evidence}")
        elif decision == "not_submitted":
            self.mark(operation_id, "not_submitted_confirmed",
                      notes=f"对账 not_submitted（预算已释放）：{evidence}")
            self.store.update_operation(operation_id, reserved_budget=0)
        elif decision == "unresolved":
            self.mark(operation_id, "needs_reconciliation",
                      notes=f"对账 unresolved（预算保留）：{evidence}")
        else:
            raise LedgerError(f"未知对账决策：{decision}（可选 "
                              "found_existing / not_submitted / unresolved）")
        return self.store.get_operation(operation_id)

    # ------------------------------------------------------------ 查询
    def needs_reconciliation(self, article_id: str) -> list[dict[str, Any]]:
        return [o for o in self.store.article_operations(article_id)
                if o["status"] in ("unknown", "needs_reconciliation", "sending")]

    def budget_used(self, article_id: str) -> int:
        return sum(o["reserved_budget"] for o in
                   self.store.article_operations(article_id))
