"""代码执行 worker 测试：真实运行、stdin、超时、危险扫描、双确认。"""
from __future__ import annotations

import unittest
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from ice_agent.domain.types import RunSpec
from ice_agent.execution.runner import (
    CodeRunner,
    ExecutionError,
    scan_danger,
    verdict,
)
from tests import temp_dir, REPO
from ice_agent.execution.process import execute_bounded


class TestRunner(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("run-")
        self.runner = CodeRunner(self.dir, allow_local_reviewed=True)

    def test_python_real_output(self):
        spec = RunSpec(language="python",
                       source='print("hello")\nprint("循环")\n', filename="a.py")
        rec = self.runner.run_python(spec, reviewed=True)
        self.assertEqual(rec.exit_code, 0)
        self.assertIn("hello", rec.stdout)
        self.assertIn("循环", rec.stdout)
        self.assertEqual(verdict(rec, spec), "ok")

    def test_stdin_events(self):
        spec = RunSpec(language="python",
                       source='x = int(input())\nprint(x * 2)\n',
                       filename="b.py", stdin_events=["21\n"])
        rec = self.runner.run_python(spec, reviewed=True)
        self.assertEqual(rec.exit_code, 0)
        self.assertIn("42", rec.stdout)
        self.assertEqual(rec.stdin_events, ["21\n"])

    def test_runtime_error_recorded_not_faked(self):
        spec = RunSpec(language="python", source="1 / 0\n", filename="c.py")
        rec = self.runner.run_python(spec, reviewed=True)
        self.assertNotEqual(rec.exit_code, 0)
        self.assertIn("ZeroDivisionError", rec.stderr)
        # 预期失败素材：exit 非零是合法产物（§14.5）
        spec2 = RunSpec(language="python", source="1 / 0\n", filename="c.py",
                        expect_failure=True)
        self.assertEqual(verdict(rec, spec2), "expected_failure_ok")

    def test_timeout(self):
        spec = RunSpec(language="python", source="import time\ntime.sleep(5)\n",
                       filename="d.py", timeout_s=1.5)
        rec = self.runner.run_python(spec, reviewed=True)
        self.assertTrue(rec.timed_out)

    def test_danger_scan_blocks(self):
        self.assertIn("shell 调用", scan_danger("import os\nos.system('dir')\n"))
        self.assertIn("网络访问", scan_danger("import requests\nrequests.get('x')\n"))
        with self.assertRaises(ExecutionError):
            self.runner.run_python(
                RunSpec(language="python", source="import os\nos.system('dir')\n",
                        filename="e.py"), reviewed=True)

    def test_dual_confirmation(self):
        guarded = CodeRunner(self.dir, allow_local_reviewed=False)
        with self.assertRaises(ExecutionError):
            guarded.run_python(
                RunSpec(language="python", source="print(1)\n", filename="f.py"),
                reviewed=True)
        with self.assertRaises(ExecutionError):
            self.runner.run_python(
                RunSpec(language="python", source="print(1)\n", filename="f.py"),
                reviewed=False)

    def test_java_compile_and_run(self):
        src = (
            "public class Hello {\n"
            "    public static void main(String[] args) {\n"
            "        System.out.println(\"你好，Java\");\n"
            "    }\n"
            "}\n"
        )
        spec = RunSpec(language="java", source=src, filename="Hello.java")
        rec = self.runner.run_java(spec, reviewed=True)
        self.assertEqual(rec.exit_code, 0, rec.stderr)
        self.assertIn("你好，Java", rec.stdout)

    def test_java_compile_error_recorded(self):
        src = "public class Bad {\n    bad syntax here\n}\n"
        spec = RunSpec(language="java", source=src, filename="Bad.java")
        rec = self.runner.run_java(spec, reviewed=True)
        self.assertNotEqual(rec.exit_code, 0)
        self.assertTrue(rec.stderr.strip())

    def test_empty_stdin_cannot_consume_parent_rpc(self):
        # A real parent with a pending RPC line, not a mock of subprocess.run.
        script='''import sys,json
from pathlib import Path
from ice_agent.execution.runner import CodeRunner
from ice_agent.domain.types import RunSpec
r=CodeRunner(Path(sys.argv[1]),allow_local_reviewed=True)
record=r.run_python(RunSpec(language="python",source="age=int(input())\\n",filename="age.py"),reviewed=True)
print(json.dumps({"stderr":record.stderr,"parent_input":sys.stdin.readline()}))
'''
        rpc='{"id":511,"method":"jobs.list","params":{"account_id":"ice-loop"}}\n'
        parent=subprocess.run([sys.executable,'-X','utf8','-c',script,str(self.dir)],input=rpc,
                              capture_output=True,text=True,encoding='utf-8',cwd=REPO,timeout=20)
        self.assertEqual(parent.returncode,0,parent.stderr)
        record=json.loads(parent.stdout)
        self.assertIn('EOFError',record['stderr'])
        self.assertNotIn('jobs.list',record['stderr'])
        self.assertEqual(record['parent_input'],rpc)

    def test_owned_workspace_cleaned_and_evidence_retained(self):
        old=self.dir/'staging'/'run-old';old.mkdir(parents=True);(old/'keep.txt').write_text('user')
        for source in ['print("ok")\n','1/0\n','import time\ntime.sleep(10)\n']:
            spec=RunSpec(language='python',filename='demo.py',source=source,timeout_s=.7)
            record=self.runner.run_python(spec,reviewed=True)
            self.assertFalse(Path(record.runtime['cwd']).exists())
            self.assertEqual(record.runtime['workspace_cleanup'],'removed_owned_workspace')
            evidence=self.dir/'run-evidence'/record.run_id
            self.assertEqual((evidence/'demo.py').read_text(encoding='utf-8'),source)
            self.assertEqual(json.loads((evidence/'run.json').read_text())['runtime']['workspace_cleanup'],'removed_owned_workspace')
        self.assertEqual((old/'keep.txt').read_text(),'user')
        self.assertEqual(list((self.dir/'staging').iterdir()),[old])

    def test_temp_and_bytecode_are_owned_not_system_temp(self):
        spec=RunSpec(language='python',filename='temp.py',source='import tempfile, pathlib, sys\np=pathlib.Path(tempfile.gettempdir())\nprint(p)\nprint(sys.dont_write_bytecode)\n(p/"generated.txt").write_text("temporary")\n')
        rec=self.runner.run_python(spec,reviewed=True)
        self.assertEqual(rec.exit_code,0,rec.stderr)
        self.assertIn(str(Path(rec.runtime['cwd'])/'.ice-tmp'),rec.stdout)
        self.assertIn('True',rec.stdout)
        self.assertFalse(Path(rec.runtime['cwd']).exists())

    def test_external_directory_and_same_named_file_preserved(self):
        caller=self.dir/'caller';caller.mkdir();source=caller/'demo.py';source.write_text('print(9)\n')
        keep=caller/'keep.txt';keep.write_text('do not delete')
        with self.assertRaisesRegex(ExecutionError,'拒绝覆盖'):
            self.runner.run_python(RunSpec(language='python',filename='demo.py',source='print(10)'),code_dir=caller,reviewed=True)
        rec=self.runner.run_python(RunSpec(language='python',filename='demo.py',source='print(9)\n'),code_dir=caller,reviewed=True)
        self.assertEqual(rec.runtime['workspace_cleanup'],'preserved_external_directory')
        self.assertEqual(source.read_text(),'print(9)\n');self.assertEqual(keep.read_text(),'do not delete')

    def test_setup_failure_and_invalid_requests_leave_no_staging_files(self):
        with patch.dict(os.environ,{'ICE_TEACHING_PYTHON':str(self.dir/'missing.exe')}):
            with self.assertRaises(ExecutionError):
                self.runner.run_python(RunSpec(language='python',filename='demo.py',source='print(1)'),reviewed=True)
        self.assertEqual(list((self.dir/'staging').iterdir()),[])
        for name in ['../escape.py','CON.py']:
            with self.assertRaises(ExecutionError):
                self.runner.run_python(RunSpec(language='python',filename=name,source='print(1)'),reviewed=True)
        self.assertEqual(list((self.dir/'staging').iterdir()),[])

    def test_bounded_output_not_accepted_as_expected_failure(self):
        rec=self.runner.run_python(RunSpec(language='python',filename='flood.py',source='while True: print("x"*8192)\n',expect_failure=True),reviewed=True)
        self.assertEqual(rec.runtime['output_limited'],'true')
        self.assertLessEqual(len(rec.stdout)+len(rec.stderr),2*1024*1024+200)
        self.assertEqual(verdict(rec,RunSpec(language='python',filename='flood.py',source='',expect_failure=True)),'output_limit_exceeded')
        self.assertFalse(Path(rec.runtime['cwd']).exists())

    def test_owned_child_tree_terminated_after_success_and_timeout(self):
        # Trusted fixture deliberately starts a child; the tutorial danger gate stays enabled.
        for wait,timeout in [(0,3),(20,.8)]:
            file=self.dir/f'child-{wait}.pid'
            script=f'import subprocess,sys,time,pathlib\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\npathlib.Path({str(file)!r}).write_text(str(p.pid))\ntime.sleep({wait})\n'
            proc,timed_out,_=execute_bounded([sys.executable,'-c',script],cwd=self.dir,env=os.environ.copy(),timeout=timeout)
            self.assertEqual(timed_out,bool(wait))
            pid=int(file.read_text())
            if os.name=='nt':
                import ctypes
                k=ctypes.WinDLL('kernel32',use_last_error=True)
                k.OpenProcess.restype=ctypes.c_void_p
                k.CloseHandle.argtypes=[ctypes.c_void_p]
                handle=k.OpenProcess(0x1000,False,pid)
                if handle:
                    code=ctypes.c_ulong();k.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
                    k.GetExitCodeProcess(handle,ctypes.byref(code));k.CloseHandle(handle)
                    self.assertNotEqual(code.value,259,'background child still running')
            else:
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)
