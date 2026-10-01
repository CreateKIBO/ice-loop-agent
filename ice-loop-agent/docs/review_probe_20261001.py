"""Offline review probes. Never contact model/TapNow services or edit app source.

Run from the project root: python docs/review_probe_20261001.py
The output describes observed defects, so a `true` result means reproduced.
All files and SQLite databases are created under .test-tmp/review-*.
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# LibreOffice's launcher reports a directory as sys.executable on this machine.
# Correct only this review process; leave all application files untouched.
if not Path(sys.executable).is_file():
    candidate = Path(sys.executable).parent / "python.exe"
    if candidate.is_file():
        sys.executable = str(candidate)

from ice_agent.cli import build_app, build_profiles, build_routes
from ice_agent.domain.store import Store
from ice_agent.domain.types import ModelProfile, sha256_text
from ice_agent.export.exporter import _code_source
from ice_agent.ledger.operations import OperationsLedger
from ice_agent.llm.errors import AuthError
from ice_agent.llm.router import LLMRequest, LLMResponse, RoleRouter, validate_simple_schema
from ice_agent.llm.transport import ChatResult, _parse_sse
from ice_agent.providers.tapnow import validate_image_file
from ice_agent.rules.facts import check_facts
from ice_agent.rules.markdown_ast import parse_markdown
from ice_agent.workflow.nodes import node_research
from tests import temp_dir
from tests.test_workflow import TestReadinessLoop, demo_spec

results = {}


class RejectTransport:
    def chat(self, *args, **kwargs):
        raise AuthError("offline simulated authentication failure")


class LengthTransport:
    def chat(self, *args, **kwargs):
        return ChatResult(content="truncated article", finish_reason="length")


profiles = build_profiles("qwen-deepseek")
routes = build_routes(profiles)
router = RoleRouter(profiles, routes, transport=RejectTransport())
with patch.object(ModelProfile, "credential", return_value="fake-offline-key"):
    answer = router.generate(LLMRequest("writer", "draft", "offline test",
                                       context={"series": "PY", "episode": 5}))
results["R01_real_route_falls_back_to_mock"] = {
    "reproduced": answer.adapter == "mock",
    "actual_adapter": answer.adapter,
    "reviewer_primary": profiles[routes["reviewer"].primary].adapter,
}

directory = temp_dir("review-")
engine, cfg, store = build_app(directory / "articles", directory / "runtime",
                               provider="mock", allow_local_exec=True)
job_id, article_id = engine.create_job(demo_spec())
original_generate = engine.router.generate
topic_calls = [0]


def changing_topic(req, **kwargs):
    response = original_generate(req, **kwargs)
    if req.node == "topic":
        topic_calls[0] += 1
        response.data["working_title"] = f"candidate-{topic_calls[0]}"
    return response


engine.router.generate = changing_topic
engine.run(job_id)
approval = store.pending_approval(job_id)
engine.decide(job_id, approval["approval_id"], "approve")
after = engine.run(job_id)
pending = store.pending_approval(job_id)
results["R02_approved_topic_regenerated"] = {
    "reproduced": after["current_node"] == "topic" and topic_calls[0] == 2,
    "calls": topic_calls[0], "state": after["state"],
    "old_title": approval["payload"]["working_title"],
    "new_title": pending["payload"]["working_title"],
}
engine.router.generate = original_generate

full_id, full_article = engine.create_job(demo_spec(), limits={"max_model_calls": 1})
completed = engine.run(full_id, auto_approver=lambda *_: ("approve", "probe", None))
assert completed["state"] == "completed", completed
actual_calls = len(store.job_invocations(full_id))
results["R03_model_call_limit_not_enforced"] = {
    "reproduced": actual_calls > 1, "configured_limit": 1,
    "actual_invocations": actual_calls,
}

image = directory / "first.png"
image.write_bytes(TestReadinessLoop.PNG_1PX)
for _ in range(4):
    engine.import_asset(full_id, 1, image)
final = engine.refinalize(full_id)
body = (Path(final["export"]["folder"]) / "01-公众号正文.md").read_text(encoding="utf-8")
results["R04_duplicate_candidates_hide_missing_slots"] = {
    "reproduced": final["final_check"]["ready"] and "待配图" in body,
    "ready": final["final_check"]["ready"],
    "accepted_candidates": engine._load_state(full_id)["final_check_report"]["assets_accepted"],
    "required_slots": engine._load_state(full_id)["final_check_report"]["assets_required"],
    "exported_images": len(final["export"]["images"]),
}

second = directory / "second.png"
second.write_bytes(TestReadinessLoop.PNG_1PX + b"offline-second-candidate")
second_candidate = engine.import_asset(full_id, 1, second)
second_final = engine.refinalize(full_id)
exported = Path(second_final["export"]["folder"]) / "images" / "figure-01.png"
results["R05_new_selected_candidate_not_exported"] = {
    "reproduced": hashlib.sha256(exported.read_bytes()).hexdigest() != second_candidate["sha256"],
    "database_selected": store.article_slots(full_article)[0]["selected_candidate"],
    "new_candidate": second_candidate["candidate_id"],
}

for slot in store.article_slots(full_article):
    if slot["figure_no"] != 1:
        engine.import_asset(full_id, slot["figure_no"], image)
state = engine._load_state(full_id)
assert "range(1, 6)" in state["integrated_md"]
state["integrated_md"] = state["integrated_md"].replace("range(1, 6)", "range(1, 7)")
engine._save_state(full_id, state)
changed = engine.refinalize(full_id)
exported_code = _code_source(state, "run-1")
results["R06_changed_code_keeps_old_run_evidence"] = {
    "reproduced": changed["final_check"]["ready"] and sha256_text(exported_code) != state["runs"]["run-1"]["code_sha256"],
    "ready": changed["final_check"]["ready"],
    "code_hash_matches": sha256_text(exported_code) == state["runs"]["run-1"]["code_sha256"],
}

broken = directory / "truncated.png"
broken.write_bytes(b"\x89PNG\r\n\x1a\n")
results["R07_only_image_header_accepted"] = {
    "reproduced": validate_image_file(broken)[0], "bytes": broken.stat().st_size,
}

for profile in build_profiles("qwen").values():
    length_router = RoleRouter({profile.profile_id: profile},
                              build_routes({profile.profile_id: profile}),
                              transport=LengthTransport())
    with patch.object(ModelProfile, "credential", return_value="fake-offline-key"):
        length_answer = length_router.generate(LLMRequest("writer", "draft", "offline"))
results["R08_truncated_responses_accepted"] = {
    "reproduced": bool(length_answer.text) and _parse_sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n', None).finish_reason == "stop",
    "length_result_returned": length_answer.text,
    "unfinished_sse_finish_reason": _parse_sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n', None).finish_reason,
}

empty_schema = {"type": "object", "fields": {
    "candidates": {"type": "list"}, "recommended": {"type": "int"}}}
results["R09_missing_business_fields_accepted"] = {
    "reproduced": validate_simple_schema({}, empty_schema) == [],
    "errors": validate_simple_schema({}, empty_schema),
}

fake_claim = {"text": "Python 3.12", "risk_type": "version", "status": "verified", "source_ids": []}
fact_report = check_facts(parse_markdown("# test\n\nPython 3.12\n"), [fake_claim])
results["R10_verified_claim_without_source_passes"] = {
    "reproduced": len(fact_report.blocking) == 0,
    "blocking": len(fact_report.blocking),
}

research_state = {"spec": demo_spec()}
research_context = SimpleNamespace(
    state=research_state, job={"job_id": full_id}, article={"article_id": full_article},
    store=store,
    router=SimpleNamespace(generate=lambda *_args, **_kwargs: LLMResponse(
        text="", data={"claims": [fake_claim.copy()]})))
node_research(research_context)
research_claim = store.article_claims(full_article)[-1]
results["R11_model_controls_verification_status"] = {
    "reproduced": research_claim["status"] == "verified" and not research_claim["source_ids"],
    "stored_status": research_claim["status"],
}

failure_id, _ = engine.create_job(demo_spec())


def failing_generate(*args, **kwargs):
    raise AuthError("offline simulated model failure")


engine.router.generate = failing_generate
raised = ""
try:
    engine.run(failure_id)
except AuthError as exc:
    raised = type(exc).__name__
results["R12_model_failure_leaves_running_job"] = {
    "reproduced": raised == "AuthError" and store.get_job(failure_id)["state"] == "running",
    "escaped_exception": raised, "stored_state": store.get_job(failure_id)["state"],
}

thread_result = []


def cross_thread_read():
    try:
        store.get_job(full_id)
    except Exception as exc:
        thread_result.append(type(exc).__name__)


thread = threading.Thread(target=cross_thread_read)
thread.start()
thread.join()
results["R13_shared_store_rejects_worker_thread"] = {
    "reproduced": thread_result == ["ProgrammingError"], "error": thread_result,
}

ledger = OperationsLedger(store)
operation = ledger.prepare(article_id="race-article", slot_id="race-slot",
                           candidate_index=1, provider="offline", prompt="offline",
                           settings={}, max_candidates=2)
barrier = threading.Barrier(2)
lease_result = []


def race_send_lease():
    connection = Store(cfg.db_path)
    local_ledger = OperationsLedger(connection)
    original_get = connection.get_operation
    first_call = [True]

    def simultaneous_read(op_id):
        row = original_get(op_id)
        if first_call[0]:
            first_call[0] = False
            barrier.wait(timeout=5)
        return row

    connection.get_operation = simultaneous_read
    try:
        row = local_ledger.acquire_send_lease(operation["operation_id"])
        lease_result.append(row["status"])
    except Exception as exc:
        lease_result.append(type(exc).__name__)
    finally:
        connection.close()


threads = [threading.Thread(target=race_send_lease) for _ in range(2)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
results["R14_send_lease_not_atomic"] = {
    "reproduced": lease_result.count("sending") == 2,
    "successful_leases": lease_result.count("sending"), "outcomes": lease_result,
}

output = ROOT / "docs" / "review_probe_20261001_results.json"
output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=False, indent=2))
print(f"Reproduced {sum(item['reproduced'] for item in results.values())}/{len(results)} offline probes.")
store.close()
