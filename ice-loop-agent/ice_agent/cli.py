"""应用装配与命令行入口。

用法示例：
    python -m ice_agent doctor
    python -m ice_agent demo                       # 离线端到端（Mock，真实执行代码）
    python -m ice_agent run --series PY --episode 5 --topic "..." \
        --provider mock --allow-local-exec
    python -m ice_agent status --job <id>
    python -m ice_agent approve --job <id> --decision approve [--choice 1]
    python -m ice_agent resume --job <id>
    python -m ice_agent reconcile --op <id> --decision unresolved --evidence "..."
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import RuntimeConfig, make_runtime_config
from .domain.store import Store
from .domain.types import ModelProfile
from .execution.runner import CodeRunner
from .export.exporter import ArticleExporter
from .ledger.operations import OperationsLedger
from .llm.capabilities import PROVIDER_PRESETS, preset_profile
from .llm.router import RoleRouter, RouteConfig
from .workflow.engine import WorkflowEngine

_HERE = Path(__file__).resolve().parent.parent
DEMO_ROOT = _HERE / ".demo-runtime"
DEMO_ARTICLES = _HERE / ".demo-articles"


def build_profiles(provider: str) -> dict[str, ModelProfile]:
    """按 provider 组装模型 profile；凭据一律从环境变量读取。"""
    if provider == "mock":
        ids = ["mock"]
    elif provider == "qwen-deepseek":
        ids = ["qwen", "deepseek"]
    else:
        ids = [provider]
    profiles: dict[str, ModelProfile] = {}
    for aid in ids:
        p = preset_profile(aid)
        profiles[p["profile_id"]] = ModelProfile(
            profile_id=p["profile_id"], adapter=p["adapter"],
            service=p["service"], protocol=p["protocol"],
            base_url=p["base_url"], model_id=p["model_id"],
            api_key_env=p["api_key_env"], region=p.get("region", ""),
            status=p["status"], capabilities=p["capabilities"])
    return profiles


def build_routes(profiles: dict[str, ModelProfile],
                 thinking_policy: str = "prefer_off") -> dict[str, RouteConfig]:
    ids = list(profiles.keys())
    primary = ids[0]
    fallbacks = ids[1:]
    writer = RouteConfig(primary, fallbacks, thinking_policy)
    planner = RouteConfig(primary, fallbacks, "prefer_off")
    return {
        "planner": planner, "researcher": planner, "writer": writer,
        "reviewer": RouteConfig(
            ids[-1] if len(ids) > 1 else primary, ids[:-1] or [], "prefer_off"),
        "title_editor": planner, "code_helper": writer,
        "visual_reviewer": RouteConfig(
            primary, [], "provider_default"),   # 视觉角色需单独验证后启用
    }


def build_app(article_root: Path, runtime_root: Path, *,
              provider: str = "mock", allow_local_exec: bool = False,
              thinking_policy: str = "prefer_off") -> tuple[
                  WorkflowEngine, RuntimeConfig, Store]:
    cfg = make_runtime_config(article_root=article_root, runtime_root=runtime_root)
    store = Store(cfg.db_path)
    profiles = build_profiles(provider)
    router = RoleRouter(profiles, build_routes(profiles, thinking_policy),
                        store=store)
    runner = CodeRunner(cfg.runtime_root, allow_local_reviewed=allow_local_exec)
    ledger = OperationsLedger(store)
    exporter = ArticleExporter(cfg.article_root, store)
    engine = WorkflowEngine(cfg, store, router, runner, ledger,
                            exporter=exporter)
    return engine, cfg, store


# ================================================================ 命令


def cmd_doctor(args) -> int:
    import os
    import shutil
    print(f"ice_agent {__version__} 自检")
    print(f"- Python：{sys.version.split()[0]}（{sys.executable}）")
    print(f"- 引擎目录：{_HERE}")
    javac = shutil.which("javac")
    print(f"- JDK：{javac or '未找到（Java 演示代码将无法执行）'}")
    print("- 模型凭据（环境变量，只报存在性）：")
    for aid, preset in PROVIDER_PRESETS.items():
        env = preset["api_key_env"]
        if env:
            has = "已配置" if os.environ.get(env) else "未配置"
            print(f"  · {aid:9s} {env:18s} {has}")
        else:
            print(f"  · {aid:9s} （离线内置，无需凭据）")
    print(f"- 默认演示 runtime：{DEMO_ROOT}")
    print(f"- 默认演示文章目录：{DEMO_ARTICLES}")
    return 0


def _print_job_result(job: dict) -> None:
    print(f"\n任务状态：{job['state']}（当前节点：{job['current_node']}）")
    if job.get("pause_reason"):
        print(f"说明：{job['pause_reason']}")


def cmd_run(args) -> int:
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root),
        provider=args.provider, allow_local_exec=args.allow_local_exec)
    spec = {
        "series": args.series, "episode": args.episode, "topic": args.topic,
        "audience": args.audience or "零基础在校学生",
        "core_benefit": args.core_benefit or "",
        "target_words": [args.words_lo, args.words_hi],
        "exercise_to_answer": args.prev_exercise or "",
        "next_episode_plan": args.next_preview or "",
        "materials": json.loads(args.materials) if args.materials else [],
        "image_provider": args.image_provider,
        "approve_local_exec": args.allow_local_exec,
    }
    job_id, article_id = engine.create_job(spec, mode=args.mode)
    print(f"已创建任务 {job_id}（文章 {article_id}）")
    approver = None
    if args.auto_approve:
        def approver(scope: str, payload: dict):
            print(f"  [预批准] 审核门 {scope}：内容 hash 已记录，按 approve 处理")
            return "approve", "预批准（CLI --auto-approve）", None
    job = engine.run(job_id, auto_approver=approver)
    _print_job_result(job)
    pending = store.pending_approval(job_id)
    if pending:
        print(f"待审核：{pending['approval_id']}（scope={pending['scope']}）")
        print("查看内容后执行：")
        print(f"  python -m ice_agent approve --job {job_id} "
              f"--decision approve [--runtime-root {args.runtime_root}]")
    return 0


def _resume_app(args, provider: str | None):
    """恢复执行的引擎：本机执行许可以任务创建时的 spec 确认为准。"""
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root), provider=provider or "qwen-deepseek",
        allow_local_exec=False)
    job = store.get_job(args.job)
    if job is not None:
        article = store.get_article(job["article_id"])
        if article and article["spec"].get("approve_local_exec"):
            engine.runner.allow_local_reviewed = True
    return engine, cfg, store


def cmd_approve(args) -> int:
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root), provider="mock")
    if args.decision not in ("approve", "reject"):
        print("decision 只能是 approve / reject")
        return 2
    approval_id = args.approval
    if approval_id is None:
        pending = store.pending_approval(args.job)
        if pending is None:
            print("该任务没有待审核项")
            return 1
        approval_id = pending["approval_id"]
    ok = engine.decide(args.job, approval_id, args.decision, args.note or "",
                       actor="cli-user", choice=args.choice,
                       expect_hash=args.hash)
    print("审核已记录" if ok else "审核失败（不存在/已决定/hash 不匹配）")
    if ok and args.decision == "approve":
        engine_run, _, _ = _resume_app(args, args.provider)
        job = engine_run.run(args.job)
        _print_job_result(job)
    return 0 if ok else 1


def cmd_resume(args) -> int:
    engine, cfg, store = _resume_app(args, args.provider)
    approver = None
    if args.auto_approve:
        def approver(scope: str, payload: dict):
            return "approve", "预批准（CLI --auto-approve）", None
    job = engine.run(args.job, auto_approver=approver)
    _print_job_result(job)
    return 0


def cmd_status(args) -> int:
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root), provider="mock")
    s = engine.status(args.job)
    job = s["job"]
    print(json.dumps({k: job[k] for k in
                      ("job_id", "article_id", "state", "current_node", "mode",
                       "pause_reason")}, ensure_ascii=False, indent=2))
    if s["pending_approval"]:
        p = s["pending_approval"]
        print(f"\n待审核：{p['approval_id']} scope={p['scope']} rev={p['revision']}")
        print("payload 摘要：" + json.dumps(p["payload"], ensure_ascii=False)[:400])
    art = store.get_article(job["article_id"])
    if art:
        print(f"\n文章 readiness：{art['readiness']} "
              f"final_title：{art.get('final_title') or art.get('working_title')}")
    return 0


def cmd_events(args) -> int:
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root), provider="mock")
    for e in store.job_events(args.job, after=args.after):
        print(f"{e['sequence']:>4} {e['occurred_at'][11:19]} {e['event_type']:<22} "
              f"{e['payload'][:160]}")
    return 0


def cmd_articles(args) -> int:
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root), provider="mock")
    rows = store.list_articles()
    if not rows:
        print("（无文章记录）")
    for a in rows:
        print(f"{a['folder_no'] or '--':>3} {a['series']}/{a['episode']:03d} "
              f"[{a['readiness']:<16}] {a['final_title'] or a['topic']} ({a['article_id']})")
    return 0


def cmd_reconcile(args) -> int:
    engine, cfg, store = build_app(
        Path(args.article_root), Path(args.runtime_root), provider="mock")
    ledger = OperationsLedger(store)
    op = ledger.reconcile(args.op, args.decision, args.evidence,
                          provider_task_ref=args.task_ref or "",
                          provider_asset_refs=json.loads(args.asset_refs)
                          if args.asset_refs else None)
    print(f"对账完成：{op['operation_id']} → {op['status']}"
          f"（预算预留 {op['reserved_budget']}）")
    return 0


def cmd_import_asset(args) -> int:
    engine, cfg, store = _resume_app(args, "mock")
    try:
        cand = engine.import_asset(args.job, args.figure,
                                   Path(args.file), accept=not args.draft_only)
    except (KeyError, ValueError) as e:
        print(f"导入失败：{e}")
        return 1
    print(f"图{args.figure} 已导入并{'采纳' if not args.draft_only else '登记为候选'}"
          f"（candidate {cand['candidate_id']}，sha256 {cand['sha256'][:12]}）")
    return 0


def cmd_finalize(args) -> int:
    engine, cfg, store = _resume_app(args, "mock")
    result = engine.refinalize(args.job)
    final = result["final_check"]
    export = result["export"]
    print(f"复检：{'就绪 ready_for_publish' if final.get('ready') else '仍未就绪'}"
          f"（阻断 {final.get('blocking', 0)} 项）")
    print(f"readiness：{result['readiness']}")
    print(f"导出目录：{export.get('folder')}")
    for img in export.get("images", []):
        print(f"  图片：{img}")
    return 0


def cmd_demo(args) -> int:
    """离线端到端：Mock 写作 + 真实代码执行 + 三审核门 + 草稿包导出。"""
    import shutil
    out_articles = Path(args.article_root) if args.article_root else DEMO_ARTICLES
    runtime = Path(args.runtime_root) if args.runtime_root else DEMO_ROOT
    if args.fresh and runtime.exists():
        shutil.rmtree(runtime, ignore_errors=True)
    engine, cfg, store = build_app(out_articles, runtime, provider="mock",
                                   allow_local_exec=True)
    spec = {
        "series": "PY", "episode": 5,
        "topic": "for 和 while：让电脑替你重复干活",
        "core_benefit": "能独立写出并跑通 for 与 while 两个循环示例",
        "target_words": [1800, 2600],
        "exercise_to_answer": "PY/004 动手题：车票判定",
        "next_episode_plan": "PY/006 列表：一次装下一串数据",
        "materials": [], "image_provider": "manual_import",
        "approve_local_exec": True,
    }
    job_id, article_id = engine.create_job(spec, mode="semi_auto")
    print(f"demo 任务 {job_id}")
    gates_seen: list[str] = []

    def approver(scope: str, payload: dict):
        gates_seen.append(scope)
        print(f"  审核门 [{scope}]：展示内容摘要后批准（hash 绑定，走同一决定路径）")
        if scope == "final_title":
            cands = payload.get("candidates", [])
            for i, c in enumerate(cands):
                mark = " ← 主选" if i == payload.get("recommended") else ""
                print(f"    {i}: {c['title']}（{c['mechanism']}，{c['total']} 分）{mark}")
            return "approve", "demo 审核通过（评分 + 排期一致性）", None
        print("    " + json.dumps(payload, ensure_ascii=False)[:200] + "…")
        return "approve", "demo 审核通过", None

    job = engine.run(job_id, auto_approver=approver, actor="demo")
    _print_job_result(job)
    print(f"经过审核门：{gates_seen}")
    article = store.get_article(article_id)
    print(f"文章：{article['final_title']}（readiness={article['readiness']}）")
    invocations = store.job_invocations(job_id)
    print(f"模型调用 {len(invocations)} 次（Mock，零费用）")
    runs = json.loads((cfg.job_dir(job_id) / "state.json").read_text(
        encoding="utf-8")).get("runs", {})
    for rid, rec in sorted(runs.items()):
        print(f"  {rid} {rec['filename']} exit={rec['exit_code']} "
              f"verdict={rec['verdict']}")
    export = json.loads((cfg.job_dir(job_id) / "state.json").read_text(
        encoding="utf-8")).get("export_result", {})
    print(f"导出目录：{export.get('folder')}")
    for f in export.get("files", []):
        print(f"  - {f}")
    return 0 if job["state"] == "completed" else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ice_agent", description="ICE Loop 公众号文章生产引擎")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--article-root", default=None)
        sp.add_argument("--runtime-root", default=None)

    sub.add_parser("doctor").set_defaults(func=cmd_doctor)

    sp = sub.add_parser("run")
    common(sp)
    sp.add_argument("--series", default="PY", choices=["PY", "JV", "AI", "WK"])
    sp.add_argument("--episode", type=int, required=True)
    sp.add_argument("--topic", required=True)
    sp.add_argument("--provider", default="qwen-deepseek",
                    help="mock / qwen-deepseek（凭据从环境变量读取）")
    sp.add_argument("--mode", default="semi_auto",
                    choices=["assisted", "semi_auto", "preapproved"])
    sp.add_argument("--audience", default=None)
    sp.add_argument("--core-benefit", default=None)
    sp.add_argument("--words-lo", type=int, default=1800)
    sp.add_argument("--words-hi", type=int, default=2600)
    sp.add_argument("--prev-exercise", default=None)
    sp.add_argument("--next-preview", default=None)
    sp.add_argument("--materials", default=None, help="JSON 数组（素材/来源）")
    sp.add_argument("--image-provider", default="manual_import",
                    choices=["manual_import", "tapnow_browser", "tapnow_mcp"])
    sp.add_argument("--allow-local-exec", action="store_true",
                    help="确认已审阅演示代码，允许受控本机执行（§14.2）")
    sp.add_argument("--auto-approve", action="store_true",
                    help="预批准模式：审核门走同一决定路径自动批准")
    sp.set_defaults(func=cmd_run)

    sp = sub.add_parser("approve")
    common(sp)
    sp.add_argument("--job", required=True)
    sp.add_argument("--approval", default=None,
                    help="审核 ID（缺省取最新待审核）")
    sp.add_argument("--decision", required=True, choices=["approve", "reject"])
    sp.add_argument("--note", default=None)
    sp.add_argument("--choice", type=int, default=None,
                    help="最终标题候选序号（final_title 门可用）")
    sp.add_argument("--hash", default=None, help="内容 hash（过期批准防护）")
    sp.add_argument("--provider", default=None,
                    help="审核后继续执行使用的 provider")
    sp.set_defaults(func=cmd_approve)

    sp = sub.add_parser("resume")
    common(sp)
    sp.add_argument("--job", required=True)
    sp.add_argument("--provider", default=None)
    sp.add_argument("--auto-approve", action="store_true")
    sp.set_defaults(func=cmd_resume)

    sp = sub.add_parser("status")
    common(sp)
    sp.add_argument("--job", required=True)
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("events")
    common(sp)
    sp.add_argument("--job", required=True)
    sp.add_argument("--after", type=int, default=0)
    sp.set_defaults(func=cmd_events)

    sp = sub.add_parser("articles")
    common(sp)
    sp.set_defaults(func=cmd_articles)

    sp = sub.add_parser("reconcile")
    common(sp)
    sp.add_argument("--op", required=True)
    sp.add_argument("--decision", required=True,
                    choices=["found_existing", "not_submitted", "unresolved"])
    sp.add_argument("--evidence", required=True)
    sp.add_argument("--task-ref", default=None)
    sp.add_argument("--asset-refs", default=None, help="JSON 数组")
    sp.set_defaults(func=cmd_reconcile)

    sp = sub.add_parser("import-asset")
    common(sp)
    sp.add_argument("--job", required=True)
    sp.add_argument("--figure", type=int, required=True, help="图号，如图 2 填 2")
    sp.add_argument("--file", required=True, help="图片文件路径（PNG/JPEG/WebP）")
    sp.add_argument("--draft-only", action="store_true",
                    help="仅登记候选，不标记采纳")
    sp.set_defaults(func=cmd_import_asset)

    sp = sub.add_parser("finalize")
    common(sp)
    sp.add_argument("--job", required=True)
    sp.set_defaults(func=cmd_finalize)

    sp = sub.add_parser("demo")
    common(sp)
    sp.add_argument("--fresh", action="store_true", help="清空演示 runtime 重跑")
    sp.set_defaults(func=cmd_demo)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # 目录缺省值：不指定时使用引擎目录下的 .demo-*，避免误写真实 output/
    if getattr(args, "article_root", None) is None:
        args.article_root = str(DEMO_ARTICLES)
    if getattr(args, "runtime_root", None) is None:
        args.runtime_root = str(DEMO_ROOT)
    return args.func(args)
