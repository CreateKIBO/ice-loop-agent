"""受限编辑 Agent 工具注册表（M5-01，报告 §11.2；ADR-007）。

铁律：
- 注册表在模块加载时固化；模型不能注册新工具、不能改变校验或权限；
- 每个工具：参数模型（pydantic extra=forbid）、权限层 read/propose/action、
  超时、输出上限、幂等标记；
- 实现只调用既有领域服务（knowledge/editorial/revisions/tasks/chat），
  不复制写入逻辑，不建第二套正文真相；
- 没有任意 shell 工具；执行代码仍走 execution.approve 批准链。
本文件零 SQL：持久化在 ice_agent/agent/storage.py 与各领域模块。
"""
from __future__ import annotations

import json
import copy
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..domain.types import new_id, now_iso
from . import storage as agent_store


class StrictArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())


PERMISSION_LEVELS = ("read", "propose", "action")


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    permission: str                 # read | propose | action
    arg_model: type[BaseModel]
    timeout_seconds: float = 30.0
    max_output_chars: int = 4000
    idempotent: bool = True


@dataclass
class AgentContext:
    account_id: str
    account: dict[str, Any]
    service: Any                    # DesktopService 门面
    store_factory: Callable[[], Any]
    run_id: str
    conversation_id: str | None = None
    turn_id: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    writing_profile: dict[str, Any] | None = None


class UnknownTool(Exception):
    pass


# ---------------------------------------------------------------- 参数模型
class SearchArticlesArgs(StrictArgs):
    query: str = Field(min_length=1, max_length=200)
    origin: str | None = None
    limit: int = Field(default=5, ge=1, le=20)


class ReadRevisionArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)
    revision_id: str | None = None
    max_chars: int = Field(default=3000, ge=200, le=8000)


class ColumnContextArgs(StrictArgs):
    series: str = Field(min_length=1, max_length=40)
    episode: int | None = Field(default=None, ge=1, le=10000)


class BrandRulesArgs(StrictArgs):
    pass


class BriefArgs(StrictArgs):
    audience: str | None = Field(default=None, max_length=2000)
    purpose: str | None = Field(default=None, max_length=2000)
    angle: str | None = Field(default=None, max_length=2000)
    constraints: list[str] = Field(default_factory=list, max_length=20)
    unknowns: list[str] = Field(default_factory=list, max_length=20)
    provenance: str = Field(default="agent", pattern="^(user|agent)$")


class ProposeTopicsArgs(StrictArgs):
    series: str = Field(min_length=1, max_length=40)
    episode: int | None = Field(default=None, ge=1, le=10000)
    directions: list[str] = Field(min_length=1, max_length=6)


class GenerateOutlineArgs(StrictArgs):
    title: str = Field(min_length=1, max_length=300)
    topic: str = Field(min_length=1, max_length=2000)
    sections: list[str] = Field(min_length=1, max_length=12)
    image_slots: list[str] = Field(default_factory=list, max_length=10)


class ProposePatchArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)
    ops: list[dict[str, Any]] = Field(min_length=1, max_length=50)
    reason: str = Field(default="", max_length=500)


class ImagePlanArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)
    slots: list[dict[str, Any]] = Field(min_length=1, max_length=20)


class ComposePromptArgs(StrictArgs):
    use_case: str = Field(min_length=1, max_length=600)
    canvas: str = Field(default="3:1", max_length=20)
    colors: str = Field(default="", max_length=300)
    exact_text: list[str] = Field(default_factory=list, max_length=8)
    layout: str = Field(default="", max_length=600)
    style: str = Field(default="flat editorial", max_length=200)
    forbidden: str = Field(default="no 3D, gradients, shadows, real product logos",
                           max_length=300)


class RequestInputArgs(StrictArgs):
    questions: list[dict[str, Any]] = Field(min_length=1, max_length=6)
    freeform: bool = False


class CreateTaskArgs(StrictArgs):
    kind: Literal['production'] = 'production'
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, max_length=120)
    priority: int = Field(default=5, ge=1, le=9)


class PrepareExecutionArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)


class InspectEvidenceArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)
    limit: int = Field(default=5, ge=1, le=20)


class BindAssetArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)
    figure_no: int = Field(ge=1, le=99)
    candidate_id: str = Field(min_length=1, max_length=100)


class SubmitReviewArgs(StrictArgs):
    candidate_id: str = Field(min_length=1, max_length=100)
    content_hash: str = Field(min_length=8, max_length=128)


class PrepareExportArgs(StrictArgs):
    job_id: str = Field(min_length=1, max_length=100)


class ListTasksArgs(StrictArgs):
    include_finished: bool = False


# ---------------------------------------------------------------- 工具实现
def _t_search_articles(ctx: AgentContext, args: SearchArticlesArgs) -> dict:
    store = ctx.store_factory()
    try:
        from ..knowledge import search
        result = search(store, ctx.account_id, args.query,
                        limit=args.limit, origin=args.origin)
        return {"mode": result["mode"], "hits": [
            {"chunk_id": r["chunk_id"], "display_name": r["display_name"],
             "section": r["section"], "text": r["text"][:600]}
            for r in result["results"]]}
    finally:
        store.close()


def _article_for_job(store, job_id: str) -> dict:
    job = store.get_job(job_id)
    if not job:
        raise ValueError("任务不存在或不属于当前公众号")
    return store.get_article(job["article_id"])


def _t_read_article_revision(ctx: AgentContext, args: ReadRevisionArgs) -> dict:
    store = ctx.store_factory()
    try:
        from ..revisions import get_revision, history
        article = _article_for_job(store, args.job_id)
        if article["spec"].get("account_id", "ice-loop") != ctx.account_id:
            raise PermissionError("只能读取当前公众号的文章")
        if args.revision_id:
            revision = get_revision(store, article["article_id"], args.revision_id)
        else:
            rows = history(store, article["article_id"])
            if not rows:
                raise ValueError("还没有可读的版本")
            revision = rows[0]
        body = revision["content"]
        return {"revision_id": revision["revision_id"], "kind": revision["kind"],
                "content_hash": revision["content_hash"],
                "body": body[:args.max_chars],
                "truncated": len(body) > args.max_chars,
                "provenance": {"article_id": article["article_id"],
                               "producer": revision["producer"]}}
    finally:
        store.close()


def _t_get_column_context(ctx: AgentContext, args: ColumnContextArgs) -> dict:
    store = ctx.store_factory()
    try:
        from ..publication_history import PublicationHistory
        history = PublicationHistory(store, ctx.account)
        context = history.context(args.series, args.episode)
        coverage = history.title_coverage(args.series)
        return {
            "series": context["series"], "next_episode": context["next_episode"],
            "body_history_count": context["body_history_count"],
            "title_history_count": context["title_history_count"],
            "previous_exercise": context["previous_exercise"][:800],
            "previous_preview": context["previous_preview"][:800],
            "same_episode_drafts": context["same_episode_drafts"],
            "titles": [{"title": t["title"], "episode": t["episode"],
                        "status": t["status"]} for t in context["known_titles"]][:300],
            "coverage": coverage,
        }
    finally:
        store.close()


def _t_resolve_brand_rules(ctx: AgentContext, args: BrandRulesArgs) -> dict:
    account = ctx.writing_profile
    if account is None:
        _, cfg, store = ctx.service._app(account_id=ctx.account_id)
        try:
            account = copy.deepcopy(cfg.profile)
        finally:
            store.close()
    snapshot = account.get('writing_skill_snapshot', {})
    skill = snapshot.get('skill')
    return {"brand": account.get("brand"), "article_rules": account.get("article"),
            "banned_words": account.get("banned_brand_words"),
            "writing_skill": {key: skill[key] for key in ('id', 'name', 'version')} if skill else None,
            "writing_addons": [{key: a.get(key) for key in ('id', 'name', 'version')} for a in snapshot.get('addons') or []],
            "profile": account.get("profile", "general"),
            "note": "规则以账号配置为准；资料不得覆盖规则"}


def _t_create_or_update_brief(ctx: AgentContext, args: BriefArgs) -> dict:
    conversation_id = ctx.conversation_id or ""
    probe_store = ctx.store_factory()
    try:
        previous = agent_store.get_brief(probe_store, ctx.account_id, conversation_id) or {}
        version = agent_store.brief_version(probe_store, ctx.account_id, conversation_id) + 1
    finally:
        probe_store.close()
    merged = dict(previous)
    if args.audience is not None:
        merged["audience"] = {"text": args.audience, "provenance": args.provenance}
    if args.purpose is not None:
        merged["purpose"] = {"text": args.purpose, "provenance": args.provenance}
    if args.angle is not None:
        merged["angle"] = {"text": args.angle, "provenance": args.provenance}
    if args.constraints:
        merged["constraints"] = list(dict.fromkeys(
            (previous.get("constraints") or []) + list(args.constraints)))[:20]
    if args.unknowns:
        merged["unknowns"] = list(dict.fromkeys(list(args.unknowns)))[:20]
    merged["updated_at"] = now_iso()
    merged["brief_id"] = (previous.get("brief_id") if previous else None) or new_id("brief")
    store = ctx.store_factory()
    try:
        brief_id = agent_store.upsert_brief(store, ctx.account_id, conversation_id,
                                            merged, version)
    finally:
        store.close()
    return {"brief_id": brief_id, "version": version, "brief": merged,
            "provenance_note": "用户事实与模型建议按字段区分（provenance）"}


def _t_propose_topics(ctx: AgentContext, args: ProposeTopicsArgs) -> dict:
    store = ctx.store_factory()
    try:
        from ..publication_history import PublicationHistory
        history = PublicationHistory(store, ctx.account)
        existing = {row["title"] for row in history.records() if row["title"]}
        candidates = []
        for direction in args.directions:
            title = direction.strip()[:120]
            candidates.append({"title": title, "duplicate_of_history": title in existing})
        return {"candidates": candidates,
                "note": "候选不自动进入排期；重复命中仅供参考，可坚持选题"}
    finally:
        store.close()


def _t_generate_outline(ctx: AgentContext, args: GenerateOutlineArgs) -> dict:
    lines = ["# " + args.title, ""]
    for index, section in enumerate(args.sections, start=1):
        lines.append("## " + section)
        lines.append("")
        if index == 1:
            lines.append("（开头段：钩子 + 承接上篇答案）")
            lines.append("")
    lines.append("## 写在最后")
    lines.append("")
    lines.append("（ICE 循环回顾 + 下期预告 + 关注引导）")
    if args.image_slots:
        lines.append("")
        for figure_no, caption in enumerate(args.image_slots, start=1):
            lines.append("![图" + str(figure_no) + "：" + caption + "](待配图：图示｜由配图方案确认)")
    return {"outline_markdown": "\n".join(lines),
            "note": "骨架候选；保存需走候选/草稿流程，不直接写批准正文"}


def _t_propose_article_patch(ctx: AgentContext, args: ProposePatchArgs) -> dict:
    result = ctx.service.call("articles.propose_patch", {
        "job_id": args.job_id, "base_revision": "current",
        "ops": args.ops, "reason": args.reason, "source_turn": ctx.turn_id or None})
    return {"proposal_id": result["proposal"]["proposal_id"],
            "status": result["proposal"]["status"],
            "op_count": len(result["proposal"]["ops"]),
            "note": "提案待用户逐项采纳"}


def _t_propose_image_plan(ctx: AgentContext, args: ImagePlanArgs) -> dict:
    plan = []
    for slot in args.slots[:20]:
        plan.append({"figure_no": int(slot.get("figure_no", 0)),
                     "kind": str(slot.get("kind", "生图")),
                     "caption": str(slot.get("caption", ""))[:200],
                     "obtain": str(slot.get("obtain", "见配图方案表"))})
    return {"plan": plan,
            "note": "仅计划；真实生图由用户在 TapNow 手工完成，不执行付费操作"}


def _t_compose_image_prompt(ctx: AgentContext, args: ComposePromptArgs) -> dict:
    parts = [
        "Use case: " + args.use_case,
        "Canvas: " + args.canvas + " ratio.",
        "Colors: " + (args.colors or "signal blue #2448DB, ink #15191F, warm white #F3F2ED") + ".",
        "Text in image (exactly): " + ("; ".join(args.exact_text) if args.exact_text else "(none)"),
        "Layout: " + (args.layout or "clear focal subject, generous margins") + ".",
        "Style: " + args.style + ".",
        "Forbidden: " + args.forbidden + ".",
    ]
    return {"prompt_en": " ".join(parts),
            "checklist": ["图内文字与字段一致", "无禁用元素", "参考图顺序已列出"],
            "note": "提示词候选；用户修改优先于候选"}


def _t_request_user_input(ctx: AgentContext, args: RequestInputArgs) -> dict:
    store = ctx.store_factory()
    try:
        question_id = agent_store.insert_question(
            store, ctx.account_id, ctx.conversation_id or "", ctx.turn_id,
            args.questions, args.freeform)
        return {"question_id": question_id, "status": "open", "questions": args.questions}
    finally:
        store.close()


def _t_create_production_task(ctx: AgentContext, args: CreateTaskArgs) -> dict:
    payload = copy.deepcopy(args.payload)
    spec = payload.get('spec')
    if not isinstance(spec,dict) or not spec:
        raise ValueError('生产任务需提供spec；缺少栏目、期号或主题时先向用户澄清')
    if (payload.get('account_id') not in (None,ctx.account_id)
            or spec.get('account_id') not in (None,ctx.account_id)):
        raise ValueError('只能创建当前会话所属公众号的任务')
    store = ctx.store_factory()
    try:
        from ..application.task_specs import production_spec
        spec = production_spec(ctx.service,store,ctx.account_id,spec)
        payload.update(spec=spec,account_id=ctx.account_id)
        from ..tasks import TaskQueue
        queue = TaskQueue(store)
        task = queue.enqueue(ctx.account_id, args.kind, payload,
                             priority=args.priority, idempotency_key=args.idempotency_key)
        return {"task_id": task["task_id"], "state": task["state"],
                "idempotent": bool(args.idempotency_key)}
    finally:
        store.close()


def _t_prepare_execution(ctx: AgentContext, args: PrepareExecutionArgs) -> dict:
    store = ctx.store_factory()
    try:
        article = _article_for_job(store, args.job_id)
        if article["spec"].get("account_id", "ice-loop") != ctx.account_id:
            raise PermissionError("只能准备当前公众号的文章")
    finally:
        store.close()
    engine, _, connection = ctx.service._job_app(args.job_id)
    try:
        state = engine._load_state(args.job_id)
        body = state.get('integrated_md','')
    finally:
        connection.close()
    from ..editorial import parse_document
    blocks = [b for b in parse_document(body)["blocks"] if b["type"] == "code"]
    return {"code_blocks": [{"lang": b["lang"], "lines": len(b["lines"]),
                             "first_line": (b["lines"][0] if b["lines"] else "")[:80]}
                            for b in blocks],
            "risks": ["执行需要现有有效批准；批准针对 source/input/timeout hash",
                      "修改代码后原批准失效"],
            "note": "代码执行已在 v3 退场；这里只提供只读摘要，任何入口都不能启动新的执行",
            "execution_retired": True}


def _t_inspect_run_evidence(ctx: AgentContext, args: InspectEvidenceArgs) -> dict:
    result = ctx.service.call("jobs.get", {"job_id": args.job_id})
    runs_raw = result.get("runs") or {}
    runs = list(runs_raw.values()) if isinstance(runs_raw, dict) else list(runs_raw)
    return {"runs": [{"run_id": r.get("run_id"), "exit": r.get("exit_code"),
                      "duration_ms": r.get("duration_ms"),
                      "verdict": r.get("verdict"),
                      "expected_failure": r.get("expected_failure", False),
                      "source_hash": (r.get("code_sha256") or "")[:16]}
                     for r in runs[:args.limit]],
            "note": "运行结果来自真实 RunRecord；Agent 不得编造 stdout"}


def _t_bind_asset_candidate(ctx: AgentContext, args: BindAssetArgs) -> dict:
    store = ctx.store_factory()
    try:
        candidate = store.get_candidate(args.candidate_id)
        if not candidate:
            raise ValueError("资源候选不存在")
        slot_id = agent_store.find_slot_for_figure(store, args.job_id, args.figure_no)
        if not slot_id:
            raise ValueError("该文章没有对应编号的图位")
        return {"binding": {"slot_id": slot_id, "figure_no": args.figure_no,
                            "candidate_id": args.candidate_id,
                            "candidate_sha256": candidate.get("sha256") or "",
                            "review_status": candidate.get("review_status") or ""},
                "note": "绑定建议已校验归属；确认走既有资源采纳流程"}
    finally:
        store.close()


def _t_submit_review(ctx: AgentContext, args: SubmitReviewArgs) -> dict:
    result = ctx.service.call("chat.submit", {
        "candidate_id": args.candidate_id, "content_hash": args.content_hash})
    return {"candidate_id": result["id"], "status": result["status"],
            "note": "进入人工审阅；不自动批准"}


def _t_prepare_export(ctx: AgentContext, args: PrepareExportArgs) -> dict:
    result = ctx.service.call("jobs.get", {"job_id": args.job_id})
    body = result.get("body", "")
    missing_slots = [slot.get("figure_no") for slot in (result.get("slots") or []) if not slot.get("valid")]
    return {"readiness": {"characters": len(body),
                          "missing_slot_candidates": missing_slots,
                          "pending_placeholders": body.count("待配图：")},
            "note": "导出预检；实际写出走受限导出服务（M9）"}


def _t_list_task_status(ctx: AgentContext, args: ListTasksArgs) -> dict:
    store = ctx.store_factory()
    try:
        from ..tasks import TaskQueue
        queue = TaskQueue(store)
        rows = queue.list_for_account(ctx.account_id,
                                      include_terminal=args.include_finished, limit=20)
        tasks = []
        for task in rows:
            job_id = queue.bound_job(task['task_id'])
            job = store.get_job(job_id) if job_id else None
            if job and _article_for_job(store,job_id)['spec'].get('account_id','ice-loop') != ctx.account_id:
                job_id,job = None,None
            tasks.append({'task_id':task['task_id'],'kind':task['kind'],'state':task['state'],
                'attempt':task['attempt'],'cancel_requested':task['cancel_requested'],
                'job_id':job_id,'engine_state':job['state'] if job else None,
                'current_node':job['current_node'] if job else None,
                'reason':job.get('pause_reason','') if job else task.get('error_code'),
                'error_code':task.get('error_code')})
        return {"tasks": tasks,
                "note": "只读查询；不提供预计完成时间"}
    finally:
        store.close()


@dataclass(frozen=True)
class RegisteredTool:
    spec: ToolSpec
    handler: Callable[[AgentContext, Any], dict]


def _build_registry() -> dict[str, RegisteredTool]:
    entries = [
        (ToolSpec("search_articles", "按关键词检索历史文章与资料片段", "read", SearchArticlesArgs),
         _t_search_articles),
        (ToolSpec("read_article_revision", "读取文章某个版本的正文（受限长度）", "read", ReadRevisionArgs),
         _t_read_article_revision),
        (ToolSpec("get_column_context", "栏目前五篇正文与全部标题/排期上下文", "read", ColumnContextArgs),
         _t_get_column_context),
        (ToolSpec("resolve_brand_rules", "读取当前公众号品牌与写作规则", "read", BrandRulesArgs),
         _t_resolve_brand_rules),
        (ToolSpec("create_or_update_brief", "保存/更新本期 brief（区分用户事实与模型建议）", "propose", BriefArgs),
         _t_create_or_update_brief),
        (ToolSpec("propose_topics", "给出候选题目（不做重复硬拦截）", "propose", ProposeTopicsArgs),
         _t_propose_topics),
        (ToolSpec("generate_outline", "生成骨架候选", "propose", GenerateOutlineArgs),
         _t_generate_outline),
        (ToolSpec("propose_article_patch", "为当前正文创建逐项修改提案", "propose", ProposePatchArgs),
         _t_propose_article_patch),
        (ToolSpec("propose_image_plan", "给出图位计划（不执行生图）", "propose", ImagePlanArgs),
         _t_propose_image_plan),
        (ToolSpec("compose_image_prompt", "按七要素生成提示词候选", "propose", ComposePromptArgs),
         _t_compose_image_prompt),
        (ToolSpec("request_user_input", "提出澄清问题并持久化", "propose", RequestInputArgs),
         _t_request_user_input),
        (ToolSpec("create_production_task", "创建文章任务：kind只能为production；payload.spec需含series、已确认期号episode和主题topic；v3 起不再运行代码", "action", CreateTaskArgs),
         _t_create_production_task),
        (ToolSpec("prepare_execution", "查看正文代码块摘要（代码执行已在 v3 退场，不能运行或批准）", "read", PrepareExecutionArgs),
         _t_prepare_execution),
        (ToolSpec("inspect_run_evidence", "查看真实运行证据（RunRecord）", "read", InspectEvidenceArgs),
         _t_inspect_run_evidence),
        (ToolSpec("bind_asset_candidate", "校验并提议图位-资源绑定", "propose", BindAssetArgs),
         _t_bind_asset_candidate),
        (ToolSpec("submit_review", "把候选稿提交人工审阅", "action", SubmitReviewArgs),
         _t_submit_review),
        (ToolSpec("prepare_export", "导出前预检", "read", PrepareExportArgs),
         _t_prepare_export),
        (ToolSpec("list_task_status", "查询任务队列状态", "read", ListTasksArgs),
         _t_list_task_status),
    ]
    registry: dict[str, RegisteredTool] = {}
    for spec, handler in entries:
        if spec.permission not in PERMISSION_LEVELS:
            raise AssertionError(spec.name)
        registry[spec.name] = RegisteredTool(spec=spec, handler=handler)
    return registry


REGISTRY: dict[str, RegisteredTool] = _build_registry()
EXPECTED_TOOL_NAMES = frozenset({
    "search_articles", "read_article_revision", "get_column_context",
    "resolve_brand_rules", "create_or_update_brief", "propose_topics",
    "generate_outline", "propose_article_patch", "propose_image_plan",
    "compose_image_prompt", "request_user_input", "create_production_task",
    "prepare_execution", "inspect_run_evidence", "bind_asset_candidate",
    "submit_review", "prepare_export", "list_task_status",
})
if set(REGISTRY) != EXPECTED_TOOL_NAMES:
    raise AssertionError("工具注册表必须覆盖报告 §11.2 的 18 项")


class ToolExecutor:
    """校验 → 执行 → 截断输出。注册表只读；模型无法注入新工具。"""

    def execute(self, ctx: AgentContext, name: str, args: dict) -> dict:
        tool = REGISTRY.get(name)
        if tool is None:
            raise UnknownTool("未注册的工具：" + str(name))
        try:
            validated = tool.spec.arg_model.model_validate(args or {})
        except ValidationError as exc:
            first = exc.errors()[0] if exc.errors() else {}
            raise ValueError("工具 " + name + " 参数不合法：" + str(first.get("msg", "invalid"))) from None
        result = tool.handler(ctx, validated)
        if not isinstance(result, dict):
            result = {"result": result}
        text = json.dumps(result, ensure_ascii=False)
        if len(text) > tool.spec.max_output_chars:
            result = {"truncated": True, "preview": text[:tool.spec.max_output_chars]}
        return result
