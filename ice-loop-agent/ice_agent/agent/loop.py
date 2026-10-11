"""有界工具执行循环（M5-03，报告 §11.3/§7.3）。

- run/turn/tool 持久化（agent_runs / agent_tool_calls）；
- 轮数（默认 6）与调用次数（默认 12）上限；上限触达停止并说明；
- 失败熔断：同工具+同参数 hash 连续两次失败 → 停止自动循环；
- 取消：每轮/每次调用前检查 cancel_event；取消后不再执行、不再写业务；
- 晚到结果：循环是同步推进的，取消标志同时阻止 run 结束后的落账。
"""
from __future__ import annotations

import json
import time
from typing import Any, Callable

from ..domain.types import new_id, now_iso
from .adapters import AgentTurnOutput, ToolCall
from .registry import AgentContext, ToolExecutor, UnknownTool

MAX_ROUNDS_DEFAULT = 6
MAX_CALLS_DEFAULT = 12
BREAKER_THRESHOLD = 2

ModelTurnFn = Callable[[int, list[dict[str, Any]]], AgentTurnOutput]


class AgentLoop:
    def __init__(self, executor: ToolExecutor | None = None,
                 *, max_rounds: int = MAX_ROUNDS_DEFAULT,
                 max_calls: int = MAX_CALLS_DEFAULT):
        self.executor = executor or ToolExecutor()
        self.max_rounds = max_rounds
        self.max_calls = max_calls
        self._turns = 0
        self._calls = 0

    # ------------------------------------------------------------- 持久化
    def _open_run(self, store, ctx: AgentContext, trigger: str) -> None:
        store.conn.execute(
            "INSERT INTO agent_runs (run_id, account_id, conversation_id, trigger,"
            " status, created_at) VALUES (?,?,?,?, 'running', ?)",
            (ctx.run_id, ctx.account_id, ctx.conversation_id or "", trigger, now_iso()))
        store.conn.commit()

    def _close_run(self, store, ctx: AgentContext, status: str, stop_reason: str) -> None:
        store.conn.execute(
            "UPDATE agent_runs SET status=?, stop_reason=?, finished_at=?,"
            " turn_count=?, tool_call_count=? WHERE run_id=?",
            (status, stop_reason, now_iso(), self._turns, self._calls, ctx.run_id))
        store.conn.commit()

    def _record_call(self, store, ctx: AgentContext, call: ToolCall, status: str,
                     result: dict | None, error_code: str | None, started: float) -> str:
        call_id = new_id("call")
        store.conn.execute(
            "INSERT INTO agent_tool_calls (call_id, run_id, turn_id, tool_name, args_hash,"
            " args_json, status, result_json, error_code, duration_ms, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (call_id, ctx.run_id, ctx.turn_id, call.name, call.args_hash,
             json.dumps(call.arguments, ensure_ascii=False)[:4000], status,
             json.dumps(result, ensure_ascii=False)[:6000] if result is not None else None,
             error_code, int((time.monotonic() - started) * 1000), now_iso()))
        store.conn.commit()
        return call_id

    # ------------------------------------------------------------- 主循环
    def run(self, ctx: AgentContext, store, *,
            model_turn: ModelTurnFn, trigger: str = "chat") -> dict[str, Any]:
        """model_turn(round_index, previous_results) -> AgentTurnOutput。

        previous_results 是上一轮全部调用的规范化结果（含错误），供模型决策。
        """
        self._turns = 0
        self._calls = 0
        self._open_run(store, ctx, trigger)
        failures: dict[tuple[str, str], int] = {}
        transcript: list[dict[str, Any]] = []
        stop_reason = ""
        successful_rounds: list[frozenset[str]] = []
        try:
            for round_index in range(self.max_rounds):
                if ctx.cancel_event.is_set():
                    stop_reason = "cancelled"
                    break
                self._turns += 1
                ctx.turn_id = ctx.turn_id or new_id("turn")
                output = model_turn(round_index, transcript)
                if not output.calls:
                    stop_reason = "model_done"
                    break
                from ..domain.types import sha256_text
                fingerprint = frozenset(
                    call.name + "|" + sha256_text(json.dumps(call.arguments, ensure_ascii=False, sort_keys=True))
                    for call in output.calls)
                if fingerprint in successful_rounds and not ctx.cancel_event.is_set():
                    # 上一轮同样的调用已全部成功、模型无新信息 → 停止，不空转烧预算。
                    # 失败轮不记入：失败重试走熔断语义；取消优先于重复判定。
                    stop_reason = "model_repeated_calls"
                    break
                round_results: list[dict[str, Any]] = []
                stop_loop = False
                for call in output.calls:
                    if self._calls >= self.max_calls:
                        stop_reason = "max_calls_reached"
                        stop_loop = True
                        break
                    if ctx.cancel_event.is_set():
                        stop_reason = "cancelled"
                        stop_loop = True
                        break
                    entry = self._execute_one(ctx, store, call, failures)
                    round_results.append(entry)
                    transcript.append(entry)
                    self._calls += 1
                    if entry.get("breaker_tripped"):
                        stop_reason = "circuit_breaker"
                        stop_loop = True
                        break
                if stop_loop:
                    break
                if round_results and all(entry.get("status") == "succeeded"
                                         for entry in round_results):
                    successful_rounds.append(fingerprint)
            else:
                stop_reason = "max_rounds_reached"
            status = "cancelled" if stop_reason == "cancelled" else (
                "failed" if stop_reason == "circuit_breaker" else "completed")
            self._close_run(store, ctx, status, stop_reason)
            return {"run_id": ctx.run_id, "status": status, "stop_reason": stop_reason,
                    "turns": self._turns, "tool_calls": self._calls,
                    "transcript": transcript}
        except BaseException:
            self._close_run(store, ctx, "failed", "exception")
            raise

    @staticmethod
    def _publish(ctx: AgentContext, event_type: str, payload: dict[str, Any]) -> None:
        publish = getattr(ctx.service, "publish_event", None)
        if callable(publish) and ctx.conversation_id:
            publish("chat:" + ctx.conversation_id, ctx.account_id, event_type,
                    {"turn_id": ctx.turn_id, "run_id": ctx.run_id, **payload})

    def _execute_one(self, ctx: AgentContext, store, call: ToolCall,
                     failures: dict[tuple[str, str], int]) -> dict[str, Any]:
        self._publish(ctx, "tool.started", {"tool": call.name})
        entry = self._execute_call(ctx, store, call, failures)
        self._publish(ctx, "tool.finished", {"tool": call.name, "status": entry.get("status")})
        return entry

    def _execute_call(self, ctx: AgentContext, store, call: ToolCall,
                      failures: dict[tuple[str, str], int]) -> dict[str, Any]:
        from ..domain.types import sha256_text
        call.args_hash = sha256_text(json.dumps(call.arguments, ensure_ascii=False, sort_keys=True))
        started = time.monotonic()
        if call.parse_error:
            self._record_call(store, ctx, call, "invalid", None, "VALIDATION_ERROR", started)
            return {"tool": call.name, "status": "invalid", "error": call.parse_error}
        key = (call.name, call.args_hash)
        try:
            result = self.executor.execute(ctx, call.name, call.arguments)
        except UnknownTool as exc:
            self._record_call(store, ctx, call, "unknown_tool", None, "UNKNOWN_TOOL", started)
            return {"tool": call.name, "status": "unknown_tool", "error": str(exc)}
        except Exception as exc:  # 工具失败可反馈；熔断计数
            failures[key] = failures.get(key, 0) + 1
            tripped = failures[key] >= BREAKER_THRESHOLD
            self._record_call(store, ctx, call, "failed", None,
                              getattr(exc, "code", "TOOL_FAILED") if hasattr(exc, "code") else "TOOL_FAILED",
                              started)
            return {"tool": call.name, "status": "failed", "error": str(exc)[:300],
                    "breaker_tripped": tripped,
                    "note": "同一调用连续失败已熔断" if tripped else None}
        self._record_call(store, ctx, call, "succeeded", result, None, started)
        failures.pop(key, None)
        return {"tool": call.name, "status": "succeeded", "result": result}


def run_id_new() -> str:
    return new_id("run")
