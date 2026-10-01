"""代码执行 worker 测试：真实运行、stdin、超时、危险扫描、双确认。"""
from __future__ import annotations

import unittest

from ice_agent.domain.types import RunSpec
from ice_agent.execution.runner import (
    CodeRunner,
    ExecutionError,
    scan_danger,
    verdict,
)
from tests import temp_dir


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
