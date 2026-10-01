"""代码执行 worker（§14）：argv 列表执行、stdin 事件、超时、RunRecord 取证。

- 永不使用 shell=True，模型不拼 shell 字符串（§14.1）；
- 沙箱目录在 runtime_root/staging 下，且拒绝 C 盘（项目铁律）；
- 静态危险动作扫描在执行前运行，命中即拒绝；
- stdout / stderr 分开归档；编码显式 UTF-8（PYTHONIOENCODING / -Dfile.encoding）；
- local_reviewed 模式需要调用方显式携带「已审阅」标志（§14.2）。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

from ..domain.types import RunRecord, RunSpec, new_id, now_iso, sha256_text
from ..paths import assert_not_c_drive, assert_within, ensure_dir, normalize

_DANGER_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("shell 调用", re.compile(r"\bos\.system\(|\bsubprocess\.|os\.popen\(")),
    ("删除类操作", re.compile(r"\bshutil\.rmtree\(|os\.remove\(|os\.unlink\(")),
    ("网络访问", re.compile(r"\bsocket\.|requests\.(get|post)|urllib\.request")),
    ("动态执行", re.compile(r"\beval\(|\bexec\(|\b__import__\(")),
    ("写系统路径", re.compile(r"open\([^)]*['\"]([A-Za-z]:\\\\|[]/]?etc|Windows)")),
]

_BASE_ENV_KEYS = ("SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT",
                  "NUMBER_OF_PROCESSORS", "TEMP", "TMP", "PATH", "LANG")


class ExecutionError(Exception):
    pass


def scan_danger(source: str) -> list[str]:
    """静态危险动作扫描（不是沙箱，只是第一道闸）。"""
    hits = []
    for label, pat in _DANGER_PATTERNS:
        if pat.search(source):
            hits.append(label)
    return hits


def build_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: os.environ[k] for k in _BASE_ENV_KEYS if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["JAVA_TOOL_OPTIONS"] = "-Dfile.encoding=UTF-8"
    if extra:
        env.update(extra)
    return env


class CodeRunner:
    def __init__(self, runtime_root: Path, *, allow_local_reviewed: bool = False):
        self.runtime_root = normalize(runtime_root)
        self.allow_local_reviewed = allow_local_reviewed

    # ------------------------------------------------------------ Python
    def run_python(self, spec: RunSpec, code_dir: Path | None = None,
                   reviewed: bool = False) -> RunRecord:
        """受控本机执行：需要 reviewed（调用方确认已审阅）与
        allow_local_reviewed（runner 配置）双确认（§14.2）。"""
        workdir = self._prepare(spec, code_dir)
        interpreter = Path(sys.executable)
        if not interpreter.is_file() and (interpreter.parent / "python.exe").is_file():
            interpreter = interpreter.parent / "python.exe"
        if not interpreter.is_file():
            raise ExecutionError("Python 执行路径无效，请在桌面启动设置中指定解释器")
        argv = [str(interpreter), spec.filename]
        return self._execute(spec, argv, workdir, reviewed)

    # -------------------------------------------------------------- Java
    def run_java(self, spec: RunSpec, code_dir: Path | None = None,
                 reviewed: bool = False) -> RunRecord:
        workdir = self._prepare(spec, code_dir)
        if not (reviewed and self.allow_local_reviewed):
            raise ExecutionError(
                "本机执行需要双确认：调用方 reviewed 标志 + runner "
                "allow_local_reviewed 配置（§14.2 受控本机模式）")
        cls = spec.filename.rsplit(".", 1)[0]
        compile_argv = ["javac", "-encoding", "UTF-8", spec.filename]
        compiled = subprocess.run(
            compile_argv, cwd=str(workdir), capture_output=True, timeout=60,
            env=build_env(), creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if compiled.returncode != 0:
            rec = self._record(
                spec, ["javac", "-encoding", "UTF-8", spec.filename], workdir,
                stdout="", stderr=compiled.stderr.decode("utf-8", "replace"),
                exit_code=compiled.returncode, duration_ms=0,
                mode="local_reviewed", timed_out=False)
            return rec
        argv = ["java", "-cp", str(workdir), cls]
        return self._execute(spec, argv, workdir, reviewed)

    # ------------------------------------------------------------ 内部
    def _prepare(self, spec: RunSpec, code_dir: Path | None) -> Path:
        if scan_danger(spec.source):
            raise ExecutionError(
                f"静态危险动作扫描未通过：{scan_danger(spec.source)}；"
                "教程演示代码不应包含系统调用/网络/删除类操作")
        if spec.language == "python":
            workdir = code_dir or ensure_dir(
                self.runtime_root / "staging" / f"run-{new_id('w')[2:]}")
        else:
            workdir = code_dir or ensure_dir(
                self.runtime_root / "staging" / f"run-{new_id('w')[2:]}")
        assert_not_c_drive(workdir)
        assert_within(workdir, self.runtime_root)
        src = workdir / spec.filename
        if Path(spec.filename).name != spec.filename:
            raise ExecutionError("源码文件名必须是单个文件名，不能包含路径")
        assert_within(src, workdir)
        src.write_text(spec.source, encoding="utf-8", newline="\n")
        return workdir

    def _execute(self, spec: RunSpec, argv: list[str], workdir: Path,
                 reviewed: bool) -> RunRecord:
        if not (reviewed and self.allow_local_reviewed):
            raise ExecutionError(
                "本机执行需要双确认：调用方 reviewed 标志 + runner "
                "allow_local_reviewed 配置（§14.2 受控本机模式）")
        mode = "local_reviewed"
        stdin_data = "".join(spec.stdin_events).encode("utf-8") \
            if spec.stdin_events else None
        started = time.monotonic()
        try:
            proc = subprocess.run(
                argv, cwd=str(workdir), input=stdin_data, capture_output=True,
                timeout=spec.timeout_s, env=build_env(),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            timed_out = False
            exit_code = proc.returncode
            out = proc.stdout
            err = proc.stderr
        except subprocess.TimeoutExpired as e:
            timed_out = True
            exit_code = -1
            out = e.stdout or b""
            err = e.stderr or b""
            if not isinstance(err, bytes):
                err = err.encode("utf-8")
            err = err + "\n[runner] execution timed out and was terminated".encode("ascii")
        duration_ms = int((time.monotonic() - started) * 1000)
        return self._record(
            spec, argv, workdir,
            stdout=out.decode("utf-8", "replace"),
            stderr=err.decode("utf-8", "replace"),
            exit_code=exit_code, duration_ms=duration_ms, mode=mode,
            timed_out=timed_out)

    def _record(self, spec: RunSpec, argv: list[str], workdir: Path, *,
                stdout: str, stderr: str, exit_code: int, duration_ms: int,
                mode: str, timed_out: bool) -> RunRecord:
        rec = RunRecord(
            run_id=new_id("run"),
            code_artifact_id=new_id("src"),
            code_sha256=sha256_text(spec.source),
            execution_mode=mode,
            argv=list(argv),
            runtime={
                "python": sys.version.split()[0],
                "os": os.name,
                "cwd": str(workdir),
            },
            stdin_events=list(spec.stdin_events),
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            timed_out=timed_out,
            started_at=now_iso(),
            duration_ms=duration_ms,
        )
        rec.output_sha256 = sha256_text(stdout + "\x00" + stderr)
        return rec


def verdict(rec: RunRecord, spec: RunSpec) -> str:
    """教学预期判定：预期失败的素材允许非零退出码（§14.5）。"""
    if rec.timed_out:
        return "timed_out"
    if spec.expect_failure:
        return "expected_failure_ok" if rec.exit_code != 0 else \
            "expected_failure_but_succeeded"
    return "ok" if rec.exit_code == 0 else "runtime_error"
