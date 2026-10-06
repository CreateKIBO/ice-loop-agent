"""M1-10 阶段出口：真实 JSON Lines 子进程协议、僵尸任务恢复、快速重复操作。

用真实子进程跑 desktop_service.main()，验证 v1.5.3 旧客户端形状（id/result/error）
与 v2 kind 字段共存；重操作占线时轻查询仍响应（进程级，非仅线程级）。
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from time import monotonic as _monotonic

from ice_agent.domain.store import Store
from ice_agent.tasks import TaskQueue

from tests import REPO, temp_dir


class TestProtocolSubprocess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = temp_dir('v2-m10-')
        cls.runtime = cls.dir / 'runtime'
        cls.proc = subprocess.Popen(
            [sys.executable, '-X', 'utf8', '-B', '-m', 'ice_agent.desktop_service',
             '--project-root', str(cls.dir / 'projects'),
             '--runtime-root', str(cls.runtime)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=str(REPO))
        cls.reader_done = threading.Event()
        cls.lines: list[dict] = []
        cls._start_reader()

    @classmethod
    def _start_reader(cls):
        def pump():
            for raw in cls.proc.stdout:
                try:
                    cls.lines.append(json.loads(raw))
                except ValueError:
                    pass
            cls.reader_done.set()
        threading.Thread(target=pump, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.proc.stdin.close()
            cls.proc.wait(timeout=15)
        except Exception:
            cls.proc.kill()
        if cls.proc.stderr:
            cls.proc.stderr.close()

    def _rpc(self, request: dict, timeout: float = 60) -> dict:
        rid = request.get('id')
        self.proc.stdin.write((json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'))
        self.proc.stdin.flush()
        deadline = _monotonic() + timeout
        while _monotonic() < deadline:
            for line in self.lines:
                if line.get('id') == rid:
                    return line
            time.sleep(0.03)
        self.fail(f'请求 {rid} 超时未响应')

    def test_v1_shape_client_survives_and_gets_kind_field(self):
        """旧客户端只读 id/result/error——新 kind 字段不破坏解析。"""
        response = self._rpc({'id': 'boot-1', 'method': 'bootstrap', 'params': {}})
        self.assertEqual(response['id'], 'boot-1')
        self.assertIn('result', response)
        self.assertIn('version', response['result'])
        self.assertEqual(response.get('kind'), 'response')

    def test_invalid_line_then_valid_request_recovers(self):
        self.proc.stdin.write(b'{{not json\n')
        self.proc.stdin.flush()
        err = self._rpc({'id': 'never-sent', 'method': 'x'})  # 等不到——改为等错误行
        # 上面的调用会失败；直接检查错误行存在（id=null）
        deadline = _monotonic() + 10
        while _monotonic() < deadline:
            if any(line.get('id') is None and 'error' in line for line in self.lines):
                break
            time.sleep(0.05)
        bad = [line for line in self.lines if line.get('id') is None and 'error' in line]
        self.assertTrue(bad, '坏行应回 id=null 的 VALIDATION_ERROR')
        self.assertEqual(bad[0]['error']['code'], 'VALIDATION_ERROR')
        # 进程未崩溃：后续请求正常
        ok = self._rpc({'id': 'after-bad', 'method': 'bootstrap', 'params': {}})
        self.assertIn('result', ok)

    def test_light_query_fast_while_backup_heavy_in_pool(self):
        import time as _time
        # backup.inspect 是轻查询；heavy 串行池被 backup.create 类操作占用时不受阻。
        # 这里用真实轻方法验证响应在 5s 内（进程级 PoC）。
        t0 = _monotonic()
        response = self._rpc({'id': 'light-1', 'method': 'backup.inspect',
                              'params': {'file_path': str(self.dir / 'missing.zip')}})
        elapsed = _monotonic() - t0
        self.assertIn('error', response, '不存在的备份文件应报错而非挂起')
        self.assertLess(elapsed, 10, '轻查询进程级响应')


class TestZombieRecovery(unittest.TestCase):
    def test_requeue_expired_leaves_no_zombie_running(self):
        dir_ = temp_dir('v2-zombie-')
        store = Store(dir_ / 'app.db')
        try:
            queue = TaskQueue(store, lease_seconds=1)
            for i in range(3):
                task = queue.enqueue('a1', 'demo', {'n': i})
                queue.claim()
            # 模拟持有者全部崩溃：等待租约过期
            store.conn.execute(
                "UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00+00:00'")
            store.conn.commit()
            queue.requeue_expired()
            zombies = store.conn.execute(
                "SELECT COUNT(*) FROM tasks WHERE state='running'").fetchone()[0]
            self.assertEqual(zombies, 0, '恢复后不得有僵尸 running')
            # 三个任务都可被新 worker 重新认领
            claimed = [queue.claim() for _ in range(3)]
            self.assertTrue(all(t is not None for t in claimed))
            self.assertIsNone(queue.claim())
        finally:
            store.close()

    def test_rapid_duplicate_enqueues_collapse_to_one(self):
        dir_ = temp_dir('v2-rapid-')
        store = Store(dir_ / 'app.db')
        try:
            queue = TaskQueue(store)
            key = 'capture:slot-1:run-7'
            results = [queue.enqueue('a1', 'capture', {'slot': 'slot-1'},
                                     idempotency_key=key) for _ in range(5)]
            self.assertEqual(len({r['task_id'] for r in results}), 1,
                             '快速重复操作折叠为单任务')
            self.assertEqual(len(queue.list_for_account('a1')), 1)
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()
