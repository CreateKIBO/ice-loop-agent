"""运维与导出 RPC（M8-01/06/07/08；M9-01/02/03）。"""
from __future__ import annotations

import json
import copy
from pathlib import Path
from typing import Any

from .. import assets_v2, ops
from ..domain.types import now_iso
from ..export.bundle import export_bundle
from . import Handler, register


def _run_evidence_status(record: dict, block: dict | None) -> dict:
    from ..domain.types import sha256_text
    reason = ""
    if block is None or record.get("code_sha256") != block["code_sha256"]:
        reason = "运行来源与当前演示代码不一致"
    elif sha256_text(record.get("source", "")) != block["code_sha256"]:
        reason = "运行源码哈希不一致"
    elif record.get("stdin_hash") != block["stdin_hash"]:
        reason = "运行输入已变化"
    elif record.get("timed_out") or record.get("runtime", {}).get("output_limited") in (True, "true"):
        reason = "运行超时或输出超限"
    elif bool(record.get("expected_failure")) != block["expected_failure"]:
        reason = "教学预期错误设置已变化"
    elif record.get("verdict") != ("expected_failure_ok" if block["expected_failure"] else "ok"):
        reason = "运行结果未通过验证"
    elif not block["expected_failure"] and record.get("exit_code") != 0:
        reason = "程序运行失败"
    elif sha256_text(record.get("stdout", "") + "\x00" + record.get("stderr", "")) != record.get("output_sha256"):
        reason = "运行输出哈希不一致"
    return {"ok": not reason, "reason": reason}


def _delivery_gate(cfg: Any, store: Any, article: dict, state: dict, body: str, mode: str) -> dict:
    """导出与交付审阅共用的就绪校验；blocking 每项带 kind，供界面给出修复入口。"""
    # R05：图位一律经领域 selected_asset 解析（含 slot 归属/审核状态/hash）。
    from ..providers.tapnow import selected_asset, validate_image_file
    figures: list[dict[str, Any]] = []
    blocking: list[dict[str, Any]] = []
    from ..export.markdown_content import unmanaged_images,managed_placeholders,run_references,program_fences,output_reference_errors
    for image in unmanaged_images(body):
        blocking.append({'kind':'image','message':'正文图片「'+(image['caption'] or '未命名图片')[:80]+'」尚未归档到本篇配图，请导入图位并在正文使用对应图位。'})
    slots = store.article_slots(article["article_id"])
    for slot in slots:
        figure_no = slot.get("figure_no")
        candidate = selected_asset(store, slot)
        if candidate is None:
            blocking.append({"kind": "image", "figure_no": figure_no,
                             "message": f"图{figure_no}没有已采纳且通过校验的图片"})
            continue
        ok, mime, _size = validate_image_file(Path(candidate["file_path"]))
        if not ok:
            blocking.append({"kind": "image", "figure_no": figure_no,
                             "message": f"图{figure_no}的来源文件不是有效图片"})
            continue
        figures.append({"figure_no": figure_no, "slot_id": slot["slot_id"],
                        "candidate_id": candidate["candidate_id"],
                        "path": candidate["file_path"], "mime": mime,
                        "sha256": candidate["sha256"],
                        "caption": slot.get("caption") or slot.get("slot_json", {}).get("caption", "")})
    figures.sort(key=lambda f: f["figure_no"])
    for order, figure in enumerate(figures, start=1):
        figure["order"] = order
    resolved={figure['figure_no'] for figure in figures}
    for placeholder in managed_placeholders(body):
        number=placeholder['figure_no']
        if number not in resolved and not any(item.get('figure_no')==number for item in blocking):
            blocking.append({'kind':'image','figure_no':number,'message':f'正文图{number}还没有已采纳的配图，请先准备这张图片'})
    # R06：ready 统一校验——规则、事实、审批基线、运行证据有效性。
    allow_ready = True
    run_refs_status: dict[str, dict[str, Any]] = {}
    rules_report: dict[str, Any] | None = None
    unverified: list[dict[str, Any]] = []
    blocks: list[dict[str, Any]] = []
    try:
        from ..execution.plan import execution_plan
        # execution_plan returns an envelope, not an iterable of rows.
        # Validate the current integrated article, including human edits.
        blocks = execution_plan({**state, "draft_md": body})["blocks"]
    except (KeyError, TypeError, ValueError) as exc:
        if mode == "ready":
            allow_ready = False
            blocking.append({"kind": "plan", "message": "无法验证当前执行计划：" + str(exc)[:120]})
    runs = state.get("runs") or {}
    for ref in output_reference_errors(body,runs):
        blocking.append({'kind':'evidence','message':f'正文中的运行结果（{ref[:12]}）与当前执行记录不一致，请重新回填真实输出'})
    planned={block['code_sha256'] for block in blocks}
    if any(program['code_sha256'] not in planned for program in program_fences(body)):
        blocking.append({'kind':'plan','message':'正文中的Python或Java代码尚未纳入当前执行计划，请检查代码围栏格式并重新准备程序'})
    for run_id, record in runs.items():
        block = next((b for b in blocks if b["code_sha256"] == record.get("code_sha256")
                      and b["stdin_hash"] == record.get("stdin_hash")), None)
        run_refs_status[run_id] = _run_evidence_status(record, block)
    for ref in run_references(body):
        if not run_refs_status.get(ref,{}).get('ok'):
            blocking.append({'kind':'evidence','message':'正文包含尚未解析或已失效的运行输出，请重新运行后核对'})
    reviewed = None
    if mode == "ready":
        from ..rules import run_all_checks
        from ..rules.facts import evidenced_claims,claim_verified
        claims = evidenced_claims(store,article['article_id'])
        rules_report = run_all_checks(body, cfg.profile, claims=claims)
        if not rules_report["passed"]:
            allow_ready = False
            blocking.append({"kind": "rules", "message": "程序化规则检查未通过"})
        unverified = [c for c in claims if not claim_verified(c)]
        if unverified:
            allow_ready = False
            blocking.append({"kind": "claims", "message": f"存在 {len(unverified)} 条未核验事实断言"})
        from ..automation import delivery_hash
        # A draft handoff hash covers title+body, not sha256(body).
        # Final delivery review is the existing body/title/asset anchor.
        reviewed = state.get("delivery_review") == delivery_hash(state, slots)
        if not reviewed:
            allow_ready = False
            blocking.append({"kind": "review", "message": "当前正文与配图尚未通过统一审阅，或审阅基线已过期"})
        for block in blocks:
            if not any(run_refs_status[key]["ok"] and record.get("code_sha256") == block["code_sha256"]
                       and record.get("stdin_hash") == block["stdin_hash"]
                       for key, record in runs.items()):
                allow_ready = False
                blocking.append({"kind": "evidence", "filename": block["filename"],
                                 "message": f"演示程序 {block['filename']} 缺少当前代码和输入的有效运行证据"})
        for run_id, status in run_refs_status.items():
            if not status["ok"]:
                allow_ready = False
                blocking.append({"kind": "evidence", "run_id": run_id,
                                 "message": f"运行证据 {run_id[:12]} 失效（{status['reason']}）"})
    return {"figures": figures, "blocking": blocking, "run_refs_status": run_refs_status,
            "allow_ready": allow_ready, "rules": rules_report, "unverified": unverified,
            "blocks": blocks, "slots": slots, "reviewed": reviewed}


@register
class OpsExportHandler(Handler):
    METHODS = frozenset({
        "tools.health", "tools.staging_report", "tools.capacity",
        "models.probe_capabilities",
        "articles.export_bundle", "articles.delivery_snapshot", "articles.delivery_confirm",
    })

    def handle(self, method: str, params: dict) -> Any:
        return getattr(self, "_" + method.replace(".", "_"))(params)

    def _account(self) -> dict:
        return self.service._account()

    def _store(self):
        _, _, store = self.service._app()
        return store

    # ------------------------------------------------------------- M8-06/07/08
    def _tools_health(self, _params: dict) -> dict:
        store = self._store()
        try:
            return ops.health_snapshot(store, self.service.runtime)
        finally:
            store.close()

    def _tools_staging_report(self, _params: dict) -> dict:
        return ops.staging_report(self.service.runtime)

    def _tools_capacity(self, _params: dict) -> dict:
        return ops.capacity_breakdown(self.service.runtime)

    # ------------------------------------------------------------- M8-01
    def _models_probe_capabilities(self, params: dict) -> dict:
        """分项探测（M8-01）：连接/流式/结构化/工具/识图。

        每个已测方面写回 profile["probe_results"]；无 Key 或未测 = untested，
        不冒充通过。真实调用会产生费用，仅用户显式触发。
        """
        provider = params.get("provider")
        with self.service._settings_guard:
            profile = copy.deepcopy(self.service.settings["profiles"].get(provider))
        if not profile:
            raise ValueError("未知供应商")
        requested = params.get("aspects") or ["connection", "stream", "structured"]
        allowed = {"connection", "stream", "structured", "tools", "vision"}
        aspects = [a for a in requested if a in allowed]
        if not aspects:
            raise ValueError("aspects 只能是 connection/stream/structured/tools/vision")
        results: dict[str, str] = {}
        from ..llm.adapters import extract_json_block, make_adapter
        from ..domain.types import ModelProfile
        p = ModelProfile(**profile)
        has_key = bool(p.credential())
        adapter = make_adapter(p) if has_key else None
        # R08 批次五：真实探测调用记入模型 invocation（与创作/生产同一账本），
        # 受 max_model_calls 预算约束；无 Key=untested 不产生任何调用。
        probe_store = self._store()
        probe_invocations = 0
        try:
            budget = int(self.service.settings.get("max_model_calls", 24))
            for aspect in aspects:
                # C3：tools/vision 不发真实请求，不走 invocation 账本；
                # 只返回 documented/untested/unknown，禁止假 verified 或假费用。
                if aspect in ("tools", "vision"):
                    if aspect == "tools":
                        results[aspect] = "unknown"
                    else:
                        caps = adapter.capabilities().get("vision") if adapter else "untested"
                        results[aspect] = caps if caps in ("documented", "verified") else "untested"
                    continue
                if not has_key:
                    results[aspect] = "untested"
                    continue
                if probe_invocations >= budget:
                    results[aspect] = "budget_exceeded"
                    continue
                try:
                    invocation_id = f"probe-{provider}-{aspect}-{now_iso()}"
                    probe_store.add_invocation({
                        "invocation_id": invocation_id, "job_id": None,
                        "node_key": f"probe_{aspect}", "role": "probe",
                        "profile_id": p.profile_id, "model_id": p.model_id,
                        "adapter": p.adapter, "attempt": 1, "status": "sending",
                        "request_hash": invocation_id, "usage": {"usage": "probe"},
                        "conversation_id": "",
                    })
                    probe_invocations += 1
                    if aspect == "connection":
                        adapter.chat([{"role": "user", "content": "仅回复 OK"}],
                                     thinking_policy="prefer_off", timeout=30)
                        results[aspect] = "verified"
                    elif aspect == "stream":
                        pieces: list[str] = []
                        adapter.chat([{"role": "user", "content": "仅回复 OK"}],
                                     thinking_policy="prefer_off", stream=True,
                                     on_delta=pieces.append, timeout=30)
                        results[aspect] = "verified" if pieces else "unsupported"
                    elif aspect == "structured":
                        result = adapter.chat(
                            [{"role": "user",
                              "content": '输出 JSON：{"ok": true}'}],
                            thinking_policy="prefer_off", want_json=True, timeout=30)
                        parsed = extract_json_block(result.content)
                        results[aspect] = "verified" if isinstance(parsed, dict) and parsed.get("ok") is True else "unsupported"
                    probe_store.finish_invocation(invocation_id, results[aspect],
                                                  {"usage": "probe"}, "stop")
                except Exception as exc:
                    results[aspect] = f"failed:{str(exc)[:120]}"
                    probe_store.finish_invocation(invocation_id, results[aspect],
                                                  {"usage": "probe"}, "",
                                                  str(exc)[:200])
        finally:
            probe_store.close()
        from ..paths import atomic_write_text
        with self.service._settings_guard:
            current = self.service.settings["profiles"].get(provider)
            if current != profile:
                raise ValueError("模型配置在检测期间已变化，请重新检测")
            updated = copy.deepcopy(self.service.settings)
            # Diagnostics belong in extra, not unsupported ModelProfile fields.
            updated_profile = updated["profiles"][provider]
            updated_profile.setdefault("extra", {})["probe_results"] = results
            if results.get("connection") == "verified":
                updated_profile["status"] = "verified"
            atomic_write_text(self.service.settings_file,
                              json.dumps(updated, ensure_ascii=False, indent=2))
            self.service.settings = updated
        return {"provider": provider, "probe_results": results,
                "note": "真实调用产生费用；untested/unknown 不代表支持"}

    # ------------------------------------------------------------- 最终交付审阅（批次 B）
    def _delivery_job(self, params: dict):
        if params.get('account_id') not in (None,self._account()['id']):
            raise ValueError('公众号已切换，请重新打开交付审阅')
        job_id = params.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("缺少任务标识")
        try:
            engine, cfg, store = self.service._job_app(job_id)
        except KeyError as exc:
            raise ValueError(str(exc.args[0] if exc.args else exc)) from None
        job = store.get_job(job_id)
        article = store.get_article(job["article_id"])
        if article["spec"].get("account_id", "ice-loop") != self._account()["id"]:
            store.close()
            raise ValueError("只能审阅当前公众号的文章")
        if article["spec"].get("image_only"):
            store.close()
            raise ValueError("补图任务请在经典界面的图位工作区完成审阅")
        return engine, cfg, store, job, article

    def _articles_delivery_snapshot(self, params: dict) -> dict:
        """只读审阅快照：与 ready 导出同一套校验，外加用户确认所需的 delivery_hash。"""
        engine, cfg, store, job, article = self._delivery_job(params)
        try:
            state = engine._load_state(job["job_id"])
            body = state.get("integrated_md", "")
            gate = _delivery_gate(cfg, store, article, state, body, "ready")
            from ..automation import delivery_hash
            from ..domain.types import sha256_text
            current = delivery_hash(state, gate["slots"])
            previous = state.get("delivery_review")
            reviewed_at = None
            for event in reversed(store.job_events(job["job_id"])):
                if event["event_type"] == "delivery.reviewed":
                    if json.loads(event["payload"] or "{}").get("content_hash") == previous:
                        reviewed_at = event["occurred_at"]
                    break
            valid = {figure["slot_id"] for figure in gate["figures"]}
            figures = []
            for slot in gate["slots"]:
                candidate = store.get_candidate(slot["selected_candidate"]) if slot.get("selected_candidate") else None
                figures.append({
                    "figure_no": slot.get("figure_no"), "slot_id": slot["slot_id"],
                    "caption": slot.get("caption") or slot.get("slot_json", {}).get("caption", ""),
                    "required": bool(slot.get("required", True)), "valid": slot["slot_id"] in valid,
                    "candidate": {key: candidate.get(key) for key in
                                  ("candidate_id", "source", "review_status", "sha256")} if candidate else None,
                })
            runs = state.get("runs") or {}
            blocking = [item for item in gate["blocking"] if item["kind"] != "review"]
            if not body.strip():
                blocking.insert(0, {"kind": "body", "message": "正文为空，请先生成或填写正文"})
            report = (gate["rules"] or {}).get("report", {})
            return {
                "job_id": job["job_id"], "job_state": job["state"], "running": bool(job["lease"]),
                "title": article.get("final_title") or article.get("topic") or "文章",
                "body_hash": sha256_text(body), "body_chars": len(body),
                "revision_id": state.get("body_revision_id", ""),
                "delivery_hash": current,
                "review": {"reviewed": previous == current, "stale": bool(previous) and previous != current,
                           "reviewed_at": reviewed_at},
                "figures": figures,
                "programs": [{"filename": block["filename"],
                              "evidence": any(gate["run_refs_status"][key]["ok"]
                                              and record.get("code_sha256") == block["code_sha256"]
                                              and record.get("stdin_hash") == block["stdin_hash"]
                                              for key, record in runs.items())}
                             for block in gate["blocks"]],
                "rules": {"passed": bool((gate["rules"] or {}).get("passed")),
                          "blocking": report.get("blocking", [])[:20],
                          "warnings": report.get("warnings", [])[:20]},
                "claims": [{key: claim.get(key) for key in ("claim_id", "text", "risk_type", "status")}
                           for claim in gate["unverified"][:30]],
                "blocking": blocking,
            }
        finally:
            store.close()

    def _articles_delivery_confirm(self, params: dict) -> dict:
        """用户明确确认当前正文/标题/配图；期望摘要不符（期间有变化）即拒绝。"""
        expected = params.get("delivery_hash")
        if not isinstance(expected, str) or len(expected) != 64:
            raise ValueError("缺少审阅快照摘要，请刷新后再确认")
        engine, _cfg, store, job, article = self._delivery_job(params)
        try:
            from ..automation import delivery_hash
            with store.transaction():
                job = store.get_job(job["job_id"])
                if job["lease"]:
                    raise ValueError("任务正在运行，请等待停止后再统一审阅")
                state = engine._load_state(job["job_id"])
                if not state.get("integrated_md", "").strip():
                    raise ValueError("正文为空，无法审阅")
                current = delivery_hash(state, store.article_slots(article["article_id"]))
                if current != expected:
                    raise ValueError("文章或配图已变化，请刷新审阅快照后再确认")
                state["delivery_review"] = current
                store.save_checkpoint(job["job_id"], state, commit=False)
                store.append_event(job["job_id"], "delivery.reviewed",
                                   {"content_hash": current, "actor": "desktop-user", "surface": "workbench"})
            engine._write_state_file(job["job_id"], state)
            return {"reviewed": True, "delivery_hash": current}
        finally:
            store.close()

    # ------------------------------------------------------------- M9-02/03
    def _articles_export_bundle(self, params: dict) -> dict:
        job_id = params.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("缺少任务标识")
        destination = params.get("destination")
        if not isinstance(destination, str) or not destination.strip():
            raise ValueError("请先通过目录选择器选择导出位置")
        mode = params.get('mode','draft')
        if mode not in ('draft','ready'):
            raise ValueError('导出模式只能是draft或ready')
        if params.get('account_id') not in (None,self._account()['id']):
            raise ValueError('公众号已切换，请重新打开文章后导出')
        try:
            engine, cfg, store = self.service._job_app(job_id)
        except KeyError as exc:
            raise ValueError(str(exc.args[0] if exc.args else exc)) from None
        try:
            job=store.get_job(job_id)
            if mode=='ready':
                future=self.service.running.get(job_id)
                if job['lease'] or future and not future.done():
                    raise ValueError('任务正在运行，请停止后重新审阅并导出')
            article = store.get_article(job["article_id"])
            if article["spec"].get("account_id", "ice-loop") != self._account()["id"]:
                raise ValueError("只能导出当前公众号的文章")
            state = engine._load_state(job_id)
            body = state.get("integrated_md", "")
            if not body.strip():
                raise ValueError("正文还没有可导出的内容")
            from ..domain.types import sha256_text
            body_hash = sha256_text(body)
            if params.get('body_hash') is not None and params['body_hash']!=body_hash:
                raise ValueError('正文已变化，请重新载入文章并确认导出版本')
            if params.get('delivery_hash') is not None:
                from ..automation import delivery_hash
                if params['delivery_hash']!=delivery_hash(state,store.article_slots(article['article_id'])):
                    raise ValueError('交付内容已变化，请重新审阅后导出')
            title = article.get("final_title") or article.get("topic") or "文章"
            # Drafts remain exportable, but must report the same outstanding
            # checks as the review screen rather than pretending to be ready.
            gate = _delivery_gate(cfg, store, article, state, body, 'ready')
            figures = gate["figures"]
            from ..domain.types import sha256_json
            asset_set_hash = sha256_json(
                [{"figure_no": f["figure_no"], "candidate_id": f["candidate_id"],
                  "sha256": f["sha256"]} for f in figures])
            return export_bundle(
                job_id=job_id, title=title, body=body,
                content_hash=body_hash,
                figures=figures, runs=state.get("runs") or {},
                run_refs_status=gate["run_refs_status"],
                allow_ready=gate["allow_ready"],
                blocking=[item["message"] for item in gate["blocking"]],
                destination=Path(destination),
                include_manifest=params.get("include_manifest", True),
                mode=mode,
                revision_id=state.get("body_revision_id", ""),
                asset_set_hash=asset_set_hash)
        finally:
            store.close()
