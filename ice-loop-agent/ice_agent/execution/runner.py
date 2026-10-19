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
import json
import shutil
import math
import stat
from contextlib import contextmanager
from pathlib import Path
from .process import execute_bounded

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


class ExecutionCancelled(ExecutionError):
    code = 'CANCELLED'


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
    def __init__(self, runtime_root: Path, *, allow_local_reviewed: bool = False,
                 should_stop=None):
        self.runtime_root = normalize(runtime_root)
        self.allow_local_reviewed = allow_local_reviewed
        self.should_stop = should_stop
        self._owned: dict[Path, str] = {}

    # ------------------------------------------------------------ Python
    def run_python(self, spec: RunSpec, code_dir: Path | None = None,
                   reviewed: bool = False) -> RunRecord:
        """受控本机执行：需要 reviewed（调用方确认已审阅）与
        allow_local_reviewed（runner 配置）双确认（§14.2）。"""
        with self._workspace(spec, code_dir, reviewed) as workdir:
            return self._run_python(spec, workdir, reviewed)

    def _run_python(self, spec, workdir, reviewed):
        if spec.execution_mode=='docker':return self._docker(spec,workdir,reviewed)
        interpreter = Path(os.environ.get('ICE_TEACHING_PYTHON') or sys.executable)
        if getattr(sys,'frozen',False) and not os.environ.get('ICE_TEACHING_PYTHON'):
            raise ExecutionError('打包程序缺少教学 Python 运行器，请修复安装')
        if not interpreter.is_file() and (interpreter.parent / "python.exe").is_file():
            interpreter = interpreter.parent / "python.exe"
        if not interpreter.is_file():
            raise ExecutionError("Python 执行路径无效，请在桌面启动设置中指定解释器")
        argv = [str(interpreter), '-B', spec.filename]
        return self._execute(spec, argv, workdir, reviewed)

    # -------------------------------------------------------------- Java
    def run_java(self, spec: RunSpec, code_dir: Path | None = None,
                 reviewed: bool = False) -> RunRecord:
        with self._workspace(spec, code_dir, reviewed) as workdir:
            return self._run_java(spec, workdir, reviewed)

    def _run_java(self, spec, workdir, reviewed):
        if spec.execution_mode=='docker':return self._docker(spec,workdir,reviewed)
        if not (reviewed and self.allow_local_reviewed):
            raise ExecutionError(
                "本机执行需要双确认：调用方 reviewed 标志 + runner "
                "allow_local_reviewed 配置（§14.2 受控本机模式）")
        cls = spec.filename.rsplit(".", 1)[0]
        compile_argv = ["javac", "-encoding", "UTF-8", spec.filename]
        started = time.monotonic()
        compiled, timed_out, limited = execute_bounded(compile_argv, cwd=workdir,
            env=self._env(workdir), stdin=b'', timeout=spec.timeout_s, should_stop=self.should_stop)
        cancelled = getattr(compiled, 'cancelled', False)
        if compiled.returncode != 0 or timed_out or limited or cancelled:
            rec = self._record(
                spec, ["javac", "-encoding", "UTF-8", spec.filename], workdir,
                stdout=compiled.stdout.decode('utf-8', 'replace'),
                stderr=compiled.stderr.decode("utf-8", "replace") + self._notice(timed_out, limited, cancelled),
                exit_code=-1 if timed_out or limited or cancelled else compiled.returncode,
                duration_ms=int((time.monotonic()-started)*1000),
                mode="local_reviewed", timed_out=timed_out, cancelled=cancelled,
                process_started=getattr(compiled,'started',True))
            rec.runtime['output_limited'] = str(limited).lower()
            return rec
        argv = ["java", "-cp", str(workdir), cls]
        return self._execute(spec, argv, workdir, reviewed)

    # ------------------------------------------------------------ 内部
    def _docker(self,spec,workdir,reviewed):
        executable=shutil.which('docker')
        if not executable:raise ExecutionError('未安装Docker。请准备Docker和指定镜像，或明确选择审阅后本机执行。')
        if not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]{0,150}',spec.container_image):raise ExecutionError('隔离执行镜像名称无效')
        ready, expired, limited=execute_bounded([executable,'image','inspect',spec.container_image],cwd=workdir,env=self._env(workdir),stdin=b'',timeout=15,should_stop=self.should_stop)
        if getattr(ready,'cancelled',False):raise ExecutionCancelled('已停止容器准备，未运行教学代码')
        if ready.returncode or expired or limited:raise ExecutionError('Docker引擎未启动或本地没有指定镜像；程序不会自动下载镜像')
        name=new_id('ice-run');mount=str(workdir)
        if ',' in mount:raise ExecutionError('Docker挂载目录不能含逗号')
        argv=[executable,'run','--rm','--pull=never','--name',name,'--network=none','--read-only','--cap-drop=ALL',
              '--security-opt=no-new-privileges','--memory=256m','--cpus=1','--pids-limit=64',
              '--mount',f'type=bind,source={mount},target=/work,readonly','--workdir=/work',
              '--tmpfs','/tmp:rw,nosuid,size=32m','--user','65534:65534','-i',spec.container_image]
        if spec.language=='python':argv+=['python','-I','-B',spec.filename]
        else:argv+=['sh','-c','javac -encoding UTF-8 -d /tmp "$1" && java -cp /tmp "$2"','--',spec.filename,spec.filename.rsplit('.',1)[0]]
        container_may_exist=True
        try:
            record=self._execute(spec,argv,workdir,reviewed)
            container_may_exist=record.runtime.get('process_started')!='false'
            return record
        finally:
            # Terminating only the client does not guarantee terminating the container.
            # If cancellation happened before the client was spawned, no run
            # request reached Docker and there is no container to remove.
            if container_may_exist:
                cleanup, expired, limited=execute_bounded([executable,'rm','-f',name],cwd=workdir,env=self._env(workdir),stdin=b'',timeout=15)
                if cleanup.returncode or expired or limited:
                    raise ExecutionError('Docker未确认容器已释放，请在Docker中检查 '+name)

    def _env(self, workdir):
        temporary = ensure_dir(workdir / '.ice-tmp')
        return build_env({'TEMP':str(temporary), 'TMP':str(temporary), 'TMPDIR':str(temporary),
                          'PYTHONDONTWRITEBYTECODE':'1'})

    @staticmethod
    def _notice(timed_out, limited, cancelled=False):
        return ('\n[runner] execution timed out and was terminated' if timed_out else '') + (
            '\n[runner] output exceeded 2 MiB; process tree terminated' if limited else '') + (
            '\n[runner] execution cancelled; owned process tree terminated' if cancelled else '')

    @contextmanager
    def _workspace(self, spec, code_dir, reviewed):
        # Reject before writing anything, including unauthorized or malformed requests.
        if not (reviewed and self.allow_local_reviewed):
            raise ExecutionError('本次执行尚未完成源码审阅授权')
        if not isinstance(spec.timeout_s,(int,float)) or isinstance(spec.timeout_s,bool) or not math.isfinite(spec.timeout_s) or not 0 < spec.timeout_s <= 120:
            raise ExecutionError('执行超时必须在0到120秒之间')
        if not isinstance(spec.filename,str) or not re.fullmatch(r'[\w.-]{1,160}',spec.filename) or spec.filename in ('.','..'):
            raise ExecutionError('源码文件名必须是单个文件名，不能包含路径')
        if not isinstance(spec.stdin_events,list) or any(not isinstance(event,str) for event in spec.stdin_events) or len(''.join(spec.stdin_events))>4000:
            raise ExecutionError('示例输入最多4000字符')
        if spec.execution_mode not in ('docker','local_reviewed') or spec.language not in ('python','java'):
            raise ExecutionError('未知执行模式或语言')
        if not isinstance(spec.source,str) or len(spec.source)>256000:
            raise ExecutionError('演示源码最多256000字符')
        hits=scan_danger(spec.source)
        if hits:
            raise ExecutionError(f'静态危险动作扫描未通过：{hits}；教程演示代码不应包含系统调用/网络/删除类操作')
        if spec.filename.endswith('.') or spec.filename.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(1,10)],*[f'LPT{i}' for i in range(1,10)]}:
            raise ExecutionError('不能使用系统保留文件名')
        workdir=normalize(code_dir) if code_dir else normalize(self.runtime_root/'staging'/f"run-{new_id('w')[2:]}")
        assert_not_c_drive(workdir)
        assert_within(workdir,self.runtime_root)
        try:
            if not code_dir:
                ensure_dir(workdir)
                token=new_id('owner')
                (workdir/'.ice-run-owner.json').write_text(json.dumps({'owner':'ice-code-runner-v1','token':token}),encoding='utf-8')
                self._owned[workdir]=token
            src=workdir/spec.filename
            assert_within(src,workdir)
            if code_dir and src.exists() and src.read_text(encoding='utf-8')!=spec.source:
                raise ExecutionError('指定目录已有同名源码，拒绝覆盖')
            src.write_text(spec.source,encoding='utf-8',newline='\n')
            yield workdir
        finally:
            token = self._owned.pop(workdir, None)
            status = 'preserved_external_directory'
            if token:
                try:
                    staging = normalize(self.runtime_root/'staging')
                    marker = workdir/'.ice-run-owner.json'
                    if workdir.parent != staging or not workdir.name.startswith('run-') or normalize(workdir) != workdir:
                        raise ValueError('临时目录边界已改变')
                    if json.loads(marker.read_text(encoding='utf-8')) != {'owner':'ice-code-runner-v1','token':token}:
                        raise ValueError('临时目录所有权已改变')
                    # Never traverse a link/junction planted by executed code.
                    for parent, dirs, files in os.walk(workdir, followlinks=False):
                        for name in [*dirs,*files]:
                            entry=Path(parent)/name; info=entry.lstat()
                            if entry.is_symlink() or getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400):
                                raise ValueError('发现链接，保留目录等待人工检查')
                    shutil.rmtree(workdir)
                    status = 'removed_owned_workspace'
                except (OSError,ValueError) as error:
                    status = 'retained: '+str(error)[:240]
            # Update durable run evidence only; historical files are never swept.
            if hasattr(self,'_record_objects'):
                for rec in self._record_objects.pop(workdir,[]):
                    rec.runtime['workspace_cleanup']=status
                    evidence=self.runtime_root/'run-evidence'/rec.run_id/'run.json'
                    evidence.write_text(json.dumps(rec.to_dict(),ensure_ascii=False,indent=2),encoding='utf-8')

    def _execute(self, spec: RunSpec, argv: list[str], workdir: Path,
                 reviewed: bool) -> RunRecord:
        if not (reviewed and self.allow_local_reviewed):
            raise ExecutionError(
                "本机执行需要双确认：调用方 reviewed 标志 + runner "
                "allow_local_reviewed 配置（§14.2 受控本机模式）")
        mode = 'docker' if spec.execution_mode=='docker' else 'local_reviewed'
        stdin_data = "".join(spec.stdin_events).encode("utf-8")
        started = time.monotonic()
        proc, timed_out, limited = execute_bounded(argv, cwd=workdir, stdin=stdin_data,
            timeout=spec.timeout_s, env=self._env(workdir), should_stop=self.should_stop)
        cancelled = getattr(proc, 'cancelled', False)
        exit_code = -1 if timed_out or limited or cancelled else proc.returncode
        out, err = proc.stdout, proc.stderr + self._notice(timed_out,limited,cancelled).encode('utf-8')
        if b'EOFError' in err or b'NoSuchElementException' in err:
            err += '\n[runner] 示例输入不足，请在执行前按 input()/Scanner 的读取顺序补充每行输入。Agent通信流不会作为程序输入。'.encode('utf-8')
        duration_ms = int((time.monotonic() - started) * 1000)
        rec = self._record(
            spec, argv, workdir,
            stdout=out.decode("utf-8", "replace"),
            stderr=err.decode("utf-8", "replace"),
            exit_code=exit_code, duration_ms=duration_ms, mode=mode,
            timed_out=timed_out, cancelled=cancelled, process_started=getattr(proc,'started',True))
        rec.runtime['output_limited'] = str(limited).lower()
        return rec

    def _record(self, spec: RunSpec, argv: list[str], workdir: Path, *,
                stdout: str, stderr: str, exit_code: int, duration_ms: int,
                mode: str, timed_out: bool, cancelled: bool = False,
                process_started: bool = True) -> RunRecord:
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
        rec.runtime['container_image']=spec.container_image if spec.execution_mode=='docker' else ''
        rec.runtime['cancelled'] = str(cancelled).lower()
        rec.runtime['process_started'] = str(process_started).lower()
        rec.runtime['ordering_semantics']='stdin/stdout/stderr separately recorded; no inferred interleaving'
        evidence=ensure_dir(self.runtime_root/'run-evidence'/rec.run_id)
        (evidence/spec.filename).write_text(spec.source,encoding='utf-8')
        rec.runtime['source_path']=str(evidence/spec.filename)
        rec.runtime['process_cleanup']='owned_process_tree_reaped' if process_started else 'not_started'
        if not hasattr(self,'_record_objects'):self._record_objects={}
        self._record_objects.setdefault(workdir,[]).append(rec)
        (evidence/'stdin.txt').write_text(''.join(spec.stdin_events),encoding='utf-8')
        (evidence/'stdout.txt').write_text(stdout,encoding='utf-8')
        (evidence/'stderr.txt').write_text(stderr,encoding='utf-8')
        (evidence/'run.json').write_text(json.dumps(rec.to_dict(),ensure_ascii=False,indent=2),encoding='utf-8')
        return rec


def verdict(rec: RunRecord, spec: RunSpec) -> str:
    """教学预期判定：预期失败的素材允许非零退出码（§14.5）。"""
    if rec.runtime.get('cancelled') == 'true':
        return 'cancelled'
    if rec.timed_out:
        return "timed_out"
    if rec.runtime.get('output_limited')=='true':
        return 'output_limit_exceeded'
    if spec.expect_failure:
        return "expected_failure_ok" if rec.exit_code != 0 else \
            "expected_failure_but_succeeded"
    return "ok" if rec.exit_code == 0 else "runtime_error"
