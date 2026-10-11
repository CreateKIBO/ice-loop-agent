"""编辑 Agent RPC handler（M5-04/05/06/07/09）：run_turn、问题续接、行动卡查询。"""
from __future__ import annotations

import json
from typing import Any

from ..agent import storage as agent_store
from ..agent.adapters import normalize_model_output
from ..agent.loop import AgentLoop, run_id_new
from ..agent.registry import AgentContext
from . import Handler, register


@register
class AgentHandler(Handler):
    METHODS = frozenset({
        "agent.run_turn", "agent.runs_list", "agent.tool_calls_list",
        "agent.questions", "agent.answer_question", "agent.brief_get",
        "agent.capabilities",
    })

    def handle(self, method: str, params: dict) -> Any:
        return getattr(self, "_" + method.replace(".", "_"))(params)

    def _account(self) -> dict:
        return self.service._account()

    def _store(self):
        _, _, store = self.service._app()
        return store

    def _store_factory(self):
        def factory():
            _, _, store = self.service._app()
            return store
        return factory

    def _agent_run_turn(self, params: dict) -> dict:
        """一轮受界工具循环。

        model_output：测试/上游注入的规范化输入（dict=原生形状、str=信封文本）；
        生产路径由 chat 流程把模型响应传进来。工具白名单/上限/熔断/取消全在
        AgentLoop 内强制执行。
        """
        conversation_id = params.get("conversation_id") or ""
        native_supported = bool(params.get("native_tools_supported"))
        model_output = params.get("model_output")
        if model_output is None:
            raise ValueError("缺少模型输出（生产路径由 chat 流程传入）")
        max_rounds = params.get("max_rounds", 6)
        max_calls = params.get("max_calls", 12)
        if not isinstance(max_rounds, int) or not 1 <= max_rounds <= 12:
            raise ValueError("轮数上限需为1–12")
        if not isinstance(max_calls, int) or not 1 <= max_calls <= 24:
            raise ValueError("调用上限需为1–24")
        account = self._account()
        loop = AgentLoop(max_rounds=max_rounds, max_calls=max_calls)
        ctx = AgentContext(
            account_id=account["id"], account=account, service=self.service,
            store_factory=self._store_factory(),
            run_id=params.get("run_id") or run_id_new(),
            conversation_id=conversation_id)
        store = self._store()
        try:
            return loop.run(ctx, store, model_turn=lambda round_index, previous:
                            normalize_model_output(model_output, native_tools_supported=native_supported))
        finally:
            store.close()

    def _agent_runs_list(self, params: dict) -> dict:
        conversation_id = params.get("conversation_id") or ""
        store = self._store()
        try:
            rows = store.conn.execute(
                "SELECT * FROM agent_runs WHERE account_id=? AND conversation_id=?"
                " ORDER BY created_at DESC LIMIT 20",
                (self._account()["id"], conversation_id)).fetchall()
            return {"runs": [dict(row) for row in rows]}
        finally:
            store.close()

    def _agent_tool_calls_list(self, params: dict) -> dict:
        run_id = params.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("缺少 run_id")
        store = self._store()
        try:
            owner = store.conn.execute(
                "SELECT account_id FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if not owner or owner["account_id"] != self._account()["id"]:
                raise ValueError("运行不存在或不属于当前公众号")
            rows = store.conn.execute(
                "SELECT call_id, turn_id, tool_name, args_json, status, error_code,"
                " result_json, duration_ms, created_at FROM agent_tool_calls"
                " WHERE run_id=? ORDER BY created_at", (run_id,)).fetchall()
            cards = []
            for row in rows:
                cards.append({
                    "call_id": row["call_id"], "turn_id": row["turn_id"],
                    "tool": row["tool_name"], "status": row["status"],
                    "error_code": row["error_code"], "duration_ms": row["duration_ms"],
                    "args_summary": json.dumps(json.loads(row["args_json"]),
                                               ensure_ascii=False)[:300] if row["args_json"] else "",
                    "result_summary": (row["result_json"] or "")[:400],
                    "created_at": row["created_at"],
                })
            return {"cards": cards}
        finally:
            store.close()

    def _agent_questions(self, params: dict) -> dict:
        conversation_id = params.get("conversation_id") or ""
        store = self._store()
        try:
            return {"questions": agent_store.open_questions(
                store, self._account()["id"], conversation_id)}
        finally:
            store.close()

    def _agent_answer_question(self, params: dict) -> dict:
        question_id = params.get("question_id")
        answers = params.get("answers")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError("缺少问题标识")
        if not isinstance(answers, dict):
            raise ValueError("回答必须是 {问题id: 答案} 对象")
        store = self._store()
        try:
            return agent_store.answer_question(store, self._account()["id"],
                                               question_id, answers)
        finally:
            store.close()

    def _agent_brief_get(self, params: dict) -> dict:
        conversation_id = params.get("conversation_id") or ""
        store = self._store()
        try:
            return {"brief": agent_store.get_brief(store, self._account()["id"], conversation_id)}
        finally:
            store.close()

    def _agent_capabilities(self, _params: dict) -> dict:
        from ..agent.registry import EXPECTED_TOOL_NAMES, REGISTRY
        return {"tools": sorted(EXPECTED_TOOL_NAMES),
                "count": len(REGISTRY),
                "permissions": sorted({t.spec.permission for t in REGISTRY.values()}),
                "note": "注册表固化；模型不能注册或改权限"}
