"""Real owned processes: stop promptly, retain evidence, and preserve other files."""
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import RunSpec
from ice_agent.execution.process import BoundedResult, execute_bounded
from ice_agent.execution.runner import CodeRunner, ExecutionCancelled, verdict
from ice_agent.tasks import TaskQueue
from ice_agent.tasks.worker import drain
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


def process_running(pid):
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            # An already reaped child, or a zombie awaiting its adoptive parent,
            # must not be mistaken for a still executing program.
            status = Path(f'/proc/{pid}/stat')
            return not status.exists() or status.read_text().split()[2] != 'Z'
        except ProcessLookupError:
            return False
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    k.OpenProcess.restype = ctypes.c_void_p
    k.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = k.OpenProcess(0x1000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:  # nonexistent PID
            return False
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        code = ctypes.c_ulong()
        if not k.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return code.value == 259
    finally:
        k.CloseHandle(handle)


class TestExecutionCancellation(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('execution-cancel-')
        self.marker = self.root/'started.pid'
        self.source = (
            'import os, time\nfrom pathlib import Path\n'
            'print("STARTED", flush=True)\n'
            f'Path({str(self.marker)!r}).write_text(str(os.getpid()))\n'
            'time.sleep(30)\nprint("MUST_NOT_FINISH")\n')

    def test_cancelled_before_launch_does_not_start_any_process(self):
        with patch('ice_agent.execution.process.subprocess.Popen') as popen:
            result, expired, limited = execute_bounded(
                ['never-launched'], cwd=self.root, env={}, should_stop=lambda: True)
        popen.assert_not_called()
        self.assertTrue(result.cancelled)
        self.assertFalse(expired or limited)

    def test_live_python_cancel_keeps_partial_evidence_and_cleans_only_own_workspace(self):
        external = self.root/'staging/run-existing'
        external.mkdir(parents=True)
        (external/'keep.txt').write_text('user file')
        runner = CodeRunner(self.root, allow_local_reviewed=True,
                            should_stop=self.marker.exists)
        spec = RunSpec(language='python', source=self.source, filename='sleep.py',
                       timeout_s=20, expect_failure=True)
        before = time.monotonic()
        record = runner.run_python(spec, reviewed=True)
        self.assertLess(time.monotonic()-before, 8, 'cancel must not wait for the 20s timeout')
        self.assertEqual(verdict(record, spec), 'cancelled')
        self.assertFalse(record.timed_out)
        self.assertIn('STARTED', record.stdout)
        self.assertNotIn('MUST_NOT_FINISH', record.stdout)
        self.assertFalse(process_running(int(self.marker.read_text())))
        self.assertEqual(record.runtime['workspace_cleanup'], 'removed_owned_workspace')
        self.assertFalse(Path(record.runtime['cwd']).exists())
        saved = json.loads((self.root/'run-evidence'/record.run_id/'run.json').read_text())
        self.assertEqual(saved['runtime']['cancelled'], 'true')
        self.assertEqual(saved['stdout'], record.stdout)
        self.assertEqual((external/'keep.txt').read_text(), 'user file')

    def test_cancellation_terminates_parent_and_background_child(self):
        marker = self.root/'tree.json'
        source = ('import subprocess,sys,time,json,os\nfrom pathlib import Path\n'
                  'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\n'
                  f'Path({str(marker)!r}).write_text(json.dumps([os.getpid(),child.pid]))\n'
                  'time.sleep(30)\n')
        before = time.monotonic()
        result, expired, _ = execute_bounded([sys.executable, '-c', source],
            cwd=self.root, env=os.environ.copy(), timeout=20, should_stop=marker.exists)
        self.assertLess(time.monotonic()-before, 8)
        self.assertTrue(result.cancelled)
        self.assertFalse(expired)
        for pid in json.loads(marker.read_text()):
            self.assertFalse(process_running(pid), 'an owned descendant is still running')

    def test_callback_exception_still_reaps_the_started_program(self):
        def stop():
            if self.marker.exists():
                raise RuntimeError('cancellation monitor failed')
            return False
        with self.assertRaisesRegex(RuntimeError, 'monitor failed'):
            execute_bounded([sys.executable, '-c', self.source], cwd=self.root,
                env=os.environ.copy(), timeout=20, should_stop=stop)
        self.assertFalse(process_running(int(self.marker.read_text())))

    def test_java_compile_cancellation_does_not_start_the_vm(self):
        calls = []
        def compile_process(argv, **kwargs):
            calls.append(argv)
            # A trusted long compiler fixture exercises the same real process
            # cancellation; no Docker/JDK dependency is hidden by this check.
            return execute_bounded([sys.executable, '-c', self.source], **kwargs)
        runner = CodeRunner(self.root, allow_local_reviewed=True, should_stop=self.marker.exists)
        spec = RunSpec(language='java', filename='Hello.java', source='public class Hello {}', timeout_s=20)
        with patch('ice_agent.execution.runner.execute_bounded', side_effect=compile_process):
            record = runner.run_java(spec, reviewed=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], 'javac')
        self.assertEqual(verdict(record, spec), 'cancelled')
        self.assertFalse(process_running(int(self.marker.read_text())))
        self.assertFalse(Path(record.runtime['cwd']).exists())

    def test_container_cleanup_is_not_cancelled_with_its_client(self):
        commands = []
        def docker(argv, **kwargs):
            commands.append((argv, kwargs))
            cancelled = 'run' in argv
            return BoundedResult(argv, -1 if cancelled else 0, b'', b'', cancelled=cancelled), False, False
        runner = CodeRunner(self.root, allow_local_reviewed=True, should_stop=lambda: True)
        spec = RunSpec(language='python', filename='demo.py', source='print(1)',
                       execution_mode='docker', container_image='python:3.12-slim')
        with patch('ice_agent.execution.runner.shutil.which', return_value='docker'), \
             patch('ice_agent.execution.runner.execute_bounded', side_effect=docker):
            record = runner.run_python(spec, reviewed=True)
        self.assertEqual(verdict(record, spec), 'cancelled')
        self.assertEqual(commands[-1][0][1:3], ['rm', '-f'])
        self.assertNotIn('should_stop', commands[-1][1], 'container cleanup must run after cancellation')
        self.assertIs(commands[1][1]['should_stop'], runner.should_stop)

    def test_cancelled_container_preflight_cannot_start_a_container(self):
        runner = CodeRunner(self.root, allow_local_reviewed=True, should_stop=lambda: True)
        spec = RunSpec(language='python', filename='demo.py', source='print(1)',
                       execution_mode='docker', container_image='python:3.12-slim')
        with patch('ice_agent.execution.runner.shutil.which', return_value='docker'), \
             patch('ice_agent.execution.runner.execute_bounded', return_value=(
                 BoundedResult([], -1, b'', b'', cancelled=True), False, False)) as execute:
            with self.assertRaises(ExecutionCancelled):
                runner.run_python(spec, reviewed=True)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(list((self.root/'staging').iterdir()), [])

    def test_cancelled_before_container_launch_does_not_report_missing_container_cleanup_failure(self):
        commands = []
        def docker(argv, **kwargs):
            commands.append(argv)
            if argv[1:3] == ['image', 'inspect']:
                return BoundedResult(argv, 0, b'', b''), False, False
            if argv[1] != 'run':
                raise AssertionError('a container that was never started must not be removed')
            return execute_bounded(argv, **kwargs)
        runner = CodeRunner(self.root, allow_local_reviewed=True, should_stop=lambda: True)
        spec = RunSpec(language='python', filename='demo.py', source='print(1)',
                       execution_mode='docker', container_image='python:3.12-slim')
        with patch('ice_agent.execution.runner.shutil.which', return_value='docker'), \
             patch('ice_agent.execution.runner.execute_bounded', side_effect=docker), \
             patch('ice_agent.execution.process.subprocess.Popen') as popen:
            record = runner.run_python(spec, reviewed=True)
        popen.assert_not_called()
        self.assertEqual(len(commands), 2)
        self.assertEqual(verdict(record, spec), 'cancelled')
        self.assertEqual(record.runtime['process_started'], 'false')
        self.assertEqual(record.runtime['process_cleanup'], 'not_started')
        self.assertEqual(record.runtime['workspace_cleanup'], 'removed_owned_workspace')


class TestEngineProgramCancellation(unittest.TestCase):
    def test_queue_cancel_interrupts_real_program_and_retains_checkpoint_without_advancing(self):
        root = temp_dir('engine-cancel-')
        marker = root/'started.pid'
        service = DesktopService(REPO, root/'runtime', root/'articles', auto_consumer=False)
        self.addCleanup(service.close)
        engine, _, store = service._app(demo=True)
        self.addCleanup(store.close)
        spec = {**demo_spec(), 'demo':True, 'account_id':'ice-loop'}
        job, _ = engine.create_job(spec)
        state = engine._load_state(job)
        state['draft_md'] = ('# 正文\n```python\nimport os, time\nfrom pathlib import Path\n'
            'print("REAL_PROGRAM_STARTED", flush=True)\n'
            f'Path({str(marker)!r}).write_text(str(os.getpid()))\n'
            'time.sleep(30)\n```\n<!--RUN_OUTPUT:run-1-->\n')
        engine._save_state(job, state)
        store.update_job(job, current_node='verify_code', state='awaiting_user')
        # Review the real code through the public, version-bound approval path.
        # A legacy broad boolean must not authorize a fixture's 30-second host
        # program any more than it could authorize a user's generated program.
        data = service.call('jobs.get',{'job_id':job})
        self.assertFalse(data['execution']['approved'])
        with patch.object(service,'_start',return_value={'started':False}):
            service.call('execution.approve',{'job_id':job,'content_hash':data['execution_hash'],
                'stdin_by_filename':data['stdin_by_filename']})
        queue = TaskQueue(store)
        task = queue.enqueue('ice-loop', 'production', {'spec':spec})
        queue.bind_job(task['task_id'], job, 'ice-loop')
        errors = []
        def work():
            try:
                drain(service, max_tasks=1)
            except Exception as error:
                errors.append(error)
        real_app = service._app
        runners = []
        def app(**kwargs):
            current, cfg, connection = real_app(**kwargs)
            runners.append(current.runner)
            return current, cfg, connection
        with patch.object(service, '_app', side_effect=app):
            thread = threading.Thread(target=work, daemon=True)
            thread.start()
            try:
                end = time.monotonic()+10
                while not marker.exists() and thread.is_alive() and time.monotonic()<end:
                    time.sleep(.05)
                self.assertTrue(marker.exists(), 'real tutorial process did not start')
                started = time.monotonic()
                queue.cancel(task['task_id'])
                thread.join(8)
                self.assertFalse(thread.is_alive(), 'cancelled program waited for execution timeout')
                self.assertLess(time.monotonic()-started, 8)
            finally:
                queue.cancel(task['task_id'])
                thread.join(25)  # own bounded fixture only, never leave it behind on assertion failure
        self.assertEqual(errors, [])
        self.assertEqual(queue.get(task['task_id'])['state'], 'cancelled')
        self.assertEqual(store.get_job(job)['state'], 'paused')
        self.assertIsNone(store.get_job(job)['lease'])
        self.assertFalse(process_running(int(marker.read_text())))
        saved = engine._load_state(job)
        self.assertEqual(saved['runs']['run-1']['verdict'], 'cancelled')
        self.assertIn('REAL_PROGRAM_STARTED', saved['runs']['run-1']['stdout'])
        self.assertEqual(saved['runs']['run-1']['runtime']['workspace_cleanup'], 'removed_owned_workspace')
        self.assertNotIn('integrated_md', saved)
        self.assertFalse(any(event['event_type']=='step.started' and json.loads(event['payload']).get('node')=='integrate_evidence'
                             for event in store.job_events(job)))
        self.assertTrue(runners)
        self.assertTrue(all(runner.should_stop is None for runner in runners), 'job callback retained after engine exit')

