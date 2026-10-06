"""Collect completed v1.5 checks; never run models, GUI, or an installer.

Run only after the final source/packaged logs and release audits exist. A stale
version, incomplete log, failed Boolean assertion, or mismatched file aborts
collection. --visual-verified records a human review performed separately.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path


VERSION = "1.5.0"
ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
TEST_ROOT = (ROOT / ".test-tmp").resolve()
RELEASE = ROOT / "release"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    require(isinstance(value, dict), f"Expected a JSON object: {path}")
    return value


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def runtime_path(result: dict, label: str) -> Path:
    runtime = Path(result.get("runtime", "")).resolve()
    require(runtime.is_dir(), f"Missing isolated runtime: {label}: {runtime}")
    require(TEST_ROOT in runtime.parents, f"Runtime outside .test-tmp: {label}")
    return runtime


def boolean_flags(result: dict, label: str) -> dict[str, bool]:
    # `packaged: false` describes the source executable, not a failed feature.
    # Nested live-site observations and geometry are evidence, not assertions.
    flags = {key: value for key, value in result.items()
             if isinstance(value, bool) and key != "packaged"}
    require(bool(flags), f"No feature assertions: {label}")
    failed = [key for key, value in flags.items() if value is not True]
    require(not failed, f"Failed feature assertions: {label}: {failed}")
    return flags


def node_summary() -> dict:
    name = "v1.5-node-tests.log"
    raw = (DOCS / name).read_text(encoding="utf-8-sig", errors="replace")
    raw = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", raw)
    counts = {}
    for key in ("tests", "pass", "fail", "cancelled", "skipped", "todo"):
        matches = re.findall(rf"^\s*(?:ℹ\s+|#\s+)?{key}\s+(\d+)\s*$", raw, re.M)
        require(bool(matches), f"Missing Node summary field: {key}")
        counts[key] = int(matches[-1])
    require(counts["pass"] > 0, "Node log contains no passes")
    require(all(counts[key] == 0 for key in ("fail", "cancelled", "skipped", "todo")),
            f"Node suite is incomplete or unsuccessful: {counts}")
    require(counts["tests"] == counts["pass"], f"Node summary mismatch: {counts}")
    return {"passed": counts["pass"], "failed": counts["fail"],
            "cancelled": counts["cancelled"], "skipped": counts["skipped"],
            "todo": counts["todo"], "tests": counts["tests"], "log": name}


def inspect_pair(kind: str, required: set[str], expected_count: int | None = None):
    source_name, packaged_name = f"v1.5-{kind}-source.log", f"v1.5-{kind}-packaged.log"
    source, packaged = read_json(DOCS / source_name), read_json(DOCS / packaged_name)
    source_flags = boolean_flags(source, source_name)
    packaged_flags = boolean_flags(packaged, packaged_name)
    require(source_flags.keys() == packaged_flags.keys(),
            f"Source and packaged {kind} assertion names differ")
    require(required <= source_flags.keys(),
            f"Required {kind} assertions missing: {sorted(required - source_flags.keys())}")
    if expected_count is not None:
        require(len(source_flags) == expected_count,
                f"Expected {expected_count} {kind} assertions, found {len(source_flags)}")
    source_runtime = runtime_path(source, source_name)
    packaged_runtime = runtime_path(packaged, packaged_name)
    require(source_runtime != packaged_runtime, f"Source and packaged {kind} reuse one runtime")
    if kind == "browser":
        require(source.get("packaged") is False and packaged.get("packaged") is True,
                "Browser logs must identify source and packaged executables")
    return source, packaged, source_flags, packaged_flags, source_runtime, packaged_runtime


def release_audits():
    require(read_json(ROOT / "desktop/package.json").get("version") == VERSION,
            "Current source version is not v1.5.0")
    source_path = TEST_ROOT / "release-source-check.json"
    binary_path = TEST_ROOT / "release-binary-check.json"
    source, binary = read_json(source_path), read_json(binary_path)
    require(source.get("version") == VERSION and binary.get("version") == VERSION,
            "Release audits are missing or still describe an earlier version")
    for key in ("renderer_matches_source", "packaged_version_matches_source"):
        require(source.get(key) is True, f"Source package audit failed: {key}")
    for key in ("zip_matches_unpacked", "setup_payload_matches_unpacked", "engine_matches_latest_build"):
        require(binary.get(key) is True, f"Binary package audit failed: {key}")
    require(binary.get("user_data_included") is False,
            "Release audit does not prove user data is excluded")
    asar = RELEASE / "win-unpacked/resources/app.asar"
    require(asar.is_file() and digest_file(asar) == source.get("asar_sha256"),
            "Release ASAR no longer matches its source audit")
    files = binary.get("files", [])
    expected = {f"ICE-Loop-Studio-{VERSION}-Setup.exe", f"ICE-Loop-Studio-{VERSION}-x64.zip"}
    require(isinstance(files, list) and len(files) == 2 and
            {item.get("name") for item in files} == expected,
            "Binary audit must describe the v1.5.0 installer and portable ZIP")
    for item in files:
        path = RELEASE / item["name"]
        require(path.is_file() and path.stat().st_size == item.get("bytes"),
                f"Release bytes changed after audit: {path.name}")
        require(digest_file(path) == item.get("sha256"),
                f"Release SHA-256 changed after audit: {path.name}")
    shutil.copy2(source_path, DOCS / "v1.5-package-source-audit.json")
    shutil.copy2(binary_path, DOCS / "v1.5-package-binary-audit.json")
    return source, binary


def copy_screenshots(chat_runtime: Path, browser_runtime: Path) -> list[dict]:
    target = DOCS / "screenshots/v1.5"
    browser_target = target / "browser"
    target.mkdir(parents=True, exist_ok=True)
    browser_target.mkdir(parents=True, exist_ok=True)
    chat_files = set(chat_runtime.glob("chat-*.png")) | set(chat_runtime.glob("v1.5-*.png"))
    require(bool(chat_files), "Packaged chat runtime contains no screenshots")
    for path in sorted(chat_files):
        require(path.stat().st_size > 0, f"Empty screenshot: {path}")
        shutil.copy2(path, target / path.name)
    browser_files = list(browser_runtime.glob("*.png"))
    require(bool(browser_files), "Packaged browser runtime contains no screenshots")
    for path in sorted(browser_files):
        require(path.stat().st_size > 0, f"Empty screenshot: {path}")
        shutil.copy2(path, browser_target / path.name)
    # Existing browser captures remain in place; initial failure logs remain in
    # docs. Nothing is deleted or renamed by this collector.
    return [{"path": relative(path), "bytes": path.stat().st_size,
             "sha256": digest_file(path)} for path in sorted(target.rglob("*.png"))]


def live_observations(source: dict, packaged: dict) -> dict:
    result = {}
    for label, run in (("source", source), ("packaged", packaged)):
        result[label] = {}
        for key in ("liveTapNow", "liveWeChat"):
            observation = run.get(key)
            require(isinstance(observation, dict), f"Missing read-only live observation: {label}/{key}")
            dom = observation.get("dom") or {}
            visible = dom.get("visibleCharacters")
            screenshot = observation.get("captured") is True
            result[label][key] = {
                "observation": observation,
                "visible_page_and_capture_observed": bool(isinstance(visible, (int, float)) and visible > 0 and screenshot),
                "complete_website_experience_verified": False,
                "counted_as_automated_feature_pass": False,
                "scope": "只读网页访问观察；没有登录、生图或发布。DOM 可见字符为 0 或截图超时不能证明页面体验完成。",
            }
    return result


def collect_runtime_issues(runtime: Path) -> dict:
    """Archive the final packaged renderer diagnostics without hiding toasts.

    The native runner writes an array of diagnostic rows, not a summary object.
    Expected confirmation/error-path toasts can exist; JavaScript programming
    errors must not. Keep the same classifier as chat-smoke.cjs and additionally
    reject a failed diagnostic read, since that cannot prove an error-free run.
    """
    source = runtime / "chat-runtime-issues.json"
    rows = json.loads(source.read_text(encoding="utf-8-sig"))
    require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
            "Packaged chat runtime diagnostics must be an array of row objects")
    names = re.compile(r"(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)")
    messages = re.compile(r"TypeError|ReferenceError|SyntaxError|Cannot set properties|Cannot read properties|is not defined|is not a function", re.I)
    unexpected = [row for row in rows if row.get("kind") == "error"
                  or names.fullmatch(str(row.get("error_name") or ""))
                  or messages.search(str(row.get("message") or ""))]
    require(not any(row.get("kind") == "instrumentation" for row in rows),
            "Packaged runtime diagnostic collection failed")
    require(not unexpected, f"Unexpected packaged renderer errors: {unexpected}")
    destination = DOCS / "v1.5-chat-packaged-runtime-issues.json"
    shutil.copy2(source, destination)
    return {"path": relative(destination), "source_path": relative(source),
            "total_entries": len(rows), "unexpected_errors": len(unexpected),
            "non_programming_error_entries": len(rows) - len(unexpected),
            "diagnostic_collection_succeeded": True,
            "sha256": digest_file(destination),
            "classifier": "Matches final chat-smoke.cjs: window errors, built-in JavaScript error names, and programming-error message patterns. All raw rows, including expected toasts, are retained."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--visual-verified", action="store_true",
                        help="Record separate visual inspection of final packaged screenshots")
    args = parser.parse_args()
    node = node_summary()
    chat_required = {"deleteConversation", "archiveConversation", "saveDraft", "clarificationReply",
                     "commandQueuedReopen", "commandCloseReopen", "commandAccountIsolation",
                     "accountSwitchUnloadsComposer", "accountSwitchInputIsolated", "accountSwitchInputRecovered",
                     "pendingSendPreservesTyping", "firstMessageHandoff", "motionPreferenceClears",
                     "pollDefersUntilChatMounted", "noUnexpectedRendererErrors"}
    browser_required = {"tapnowRouteInside", "remoteHasNoBridge", "remoteShortcutOpensLocalPalette",
                        "preferencesCoverRemoteView", "minimumHostFullyVisible", "accountCookiesIsolated"}
    chat_source, chat_packaged, chat_source_flags, chat_packaged_flags, chat_source_runtime, chat_runtime = inspect_pair("chat", chat_required)
    browser_source, browser_packaged, browser_source_flags, browser_packaged_flags, browser_source_runtime, browser_runtime = inspect_pair("browser", browser_required, 25)
    require(len({chat_source_runtime, chat_runtime, browser_source_runtime, browser_runtime}) == 4,
            "GUI runs must use four separate isolated runtimes")
    phases = json.loads((chat_runtime / "chat-progress-stages.json").read_text(encoding="utf-8-sig"))
    require(isinstance(phases, list) and all(isinstance(item, str) for item in phases)
            and "receiving" in phases and len(set(phases)) >= 2,
            f"Receiving and at least two distinct UI phases must be observed: {phases}")
    runtime_issues = collect_runtime_issues(chat_runtime)
    source_audit, binary_audit = release_audits()
    screenshots = copy_screenshots(chat_runtime, browser_runtime)
    history = sorted({path.name for path in DOCS.glob("v1.5-*-failure.log")} |
                     {path.name for path in DOCS.glob("v1.5-*-frame-rounding.log")})
    report = {
        "version": VERSION,
        "recorded_at": datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).isoformat(),
        "node": node,
        "source_desktop": {"passed": len(chat_source_flags), "failed": 0,
                           "log": "v1.5-chat-source.log", "assertion_names": sorted(chat_source_flags), "result": chat_source},
        "packaged_desktop": {"passed": len(chat_packaged_flags), "failed": 0,
                             "log": "v1.5-chat-packaged.log", "assertion_names": sorted(chat_packaged_flags),
                             "result": chat_packaged, "observed_ui_phases": phases,
                             "runtime_diagnostics": runtime_issues},
        "source_browser": {"passed": len(browser_source_flags), "failed": 0,
                           "log": "v1.5-browser-source.log", "assertion_names": sorted(browser_source_flags), "result": browser_source},
        "packaged_browser": {"passed": len(browser_packaged_flags), "failed": 0,
                             "log": "v1.5-browser-packaged.log", "assertion_names": sorted(browser_packaged_flags), "result": browser_packaged},
        "same_source_and_packaged_assertion_names": {"chat": True, "browser": True},
        "packaged_ui_visually_verified": args.visual_verified,
        "release_source": source_audit,
        "release_binaries": binary_audit,
        "screenshots": screenshots,
        "read_only_live_website_observations": live_observations(browser_source, browser_packaged),
        "boundaries": {
            "paid_model_calls_performed": False,
            "controlled_local_http_sse_adapter_test": True,
            "source_and_packaged_isolated_runtimes": True,
            "actual_user_workspace_modified": False,
            "actual_user_installation_modified": False,
            "actual_user_records_deleted_or_archived": False,
            "installer_executed": False,
            "tapnow_login_or_generation_performed": False,
            "wechat_publication_performed": False,
            "production_website_experience_verified": False,
            "live_sites_read_only_observed": True,
            "G_pyshot_tmp_used": False,
        },
        "initial_desktop_attempts": history,
        "notes": [
            "Counts are read from final logs. Source and packaged runs repeat the same logical GUI assertions; they are recorded separately, not presented as distinct unique tests.",
            "No v1.5 Python backend test count is inferred from earlier releases.",
            "Browser `packaged` metadata and nested live-site observations are excluded from Boolean feature counts.",
            "Progress records distinct phases; validation requires receiving plus at least one other phase, not a simulated progress percentage.",
            "Final packaged renderer diagnostic rows are archived without filtering; collection aborts on unexpected programming errors or unavailable instrumentation.",
            "Live TapNow/WeChat DOM visibility or screenshot timeout remains recorded as incomplete read-only observation, never as verified generation or publishing.",
            "Visual verification is a separate explicit flag; the collector does not inspect screenshots.",
            "Initial failed logs are retained as history and do not replace final successful logs.",
        ],
        "reference_documents": ["docs/v1.5-research.md", "docs/v1.5-review.md"],
    }
    (DOCS / "v1.5-验收结果.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"version": VERSION, "node": node["passed"],
                      "source_chat": len(chat_source_flags), "packaged_chat": len(chat_packaged_flags),
                      "source_browser": len(browser_source_flags), "packaged_browser": len(browser_packaged_flags),
                      "screenshots": len(screenshots), "visual_verified": args.visual_verified}, ensure_ascii=False))


if __name__ == "__main__":
    main()
