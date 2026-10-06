"""M1-04 有限并发 dispatch 测试：重操作占线时轻查询/取消仍即时响应。"""
from __future__ import annotations

import json
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from ice_agent.rpc_channel import RpcChannel


class TestPooledDispatch(unittest.TestCase):
    def setUp(self):
        self.out_lines: list[bytes] = []
        self.lock = threading.Lock()

    def _write(self, payload: bytes) -> None:
        with self.lock:
            self.out_lines.append(payload)

    def _parsed(self):
        with self.lock:
            return [json.loads(line) for line in self.out_lines]

    def test_light_query_responds_while_heavy_call_in_flight(self):
        started = threading.Event()
        release = threading.Event()
        timings: dict[str, float] = {}

        def dispatch(method, params):
            if method == 'chat.send':
                started.set()
                release.wait(10)
                return {'heavy': True}
            return {'light': method}

        pool = ThreadPoolExecutor(max_workers=2)
        heavy_lock = threading.Lock()

        def routed_dispatch(method, params):
            if method in HEAVY:
                with heavy_lock:
                    return dispatch(method, params)
            return dispatch(method, params)

        HEAVY = {'chat.send'}
        channel = RpcChannel(routed_dispatch, write=self._write,
                             executor=pool, route=lambda m: 'pool' if m in HEAVY else 'inline')
        try:
            channel.handle_raw(json.dumps({'id': 'h1', 'method': 'chat.send', 'params': {}}).encode())
            self.assertTrue(started.wait(5), '重操作应已在池内开始')
            t0 = time.monotonic()
            channel.handle_raw(json.dumps({'id': 'l1', 'method': 'jobs.list', 'params': {}}).encode())
            channel.handle_raw(json.dumps({'id': 'l2', 'method': 'chat.stop', 'params': {}}).encode())
            elapsed = time.monotonic() - t0
            self.assertLess(elapsed, 2.0, '轻查询/取消不得等待重操作完成')
            results = {r.get('id'): r for r in self._parsed()}
            self.assertEqual(results['l1']['result'], {'light': 'jobs.list'})
            self.assertEqual(results['l2']['result'], {'light': 'chat.stop'})
            release.set()
            # 等重操作响应写出
            deadline = time.monotonic() + 5
            while 'h1' not in results and time.monotonic() < deadline:
                time.sleep(0.05)
                results = {r.get('id'): r for r in self._parsed()}
            self.assertEqual(results['h1']['result'], {'heavy': True})
        finally:
            release.set()
            pool.shutdown(wait=True)

    def test_heavy_calls_serialize_like_v15(self):
        order: list[str] = []
        gate = threading.Event()

        def dispatch(method, params):
            if params.get('first'):
                order.append('start-1')
                gate.wait(5)
                order.append('end-1')
                return 'one'
            order.append('start-2')
            return 'two'

        pool = ThreadPoolExecutor(max_workers=2)
        heavy_lock = threading.Lock()

        def routed(method, params):
            with heavy_lock:
                return dispatch(method, params)

        channel = RpcChannel(routed, write=self._write,
                             executor=pool, route=lambda m: 'pool')
        try:
            channel.handle_raw(json.dumps({'id': 'a', 'method': 'x', 'params': {'first': True}}).encode())
            deadline = time.monotonic() + 5
            while 'start-1' not in order and time.monotonic() < deadline:
                time.sleep(0.02)
            channel.handle_raw(json.dumps({'id': 'b', 'method': 'x', 'params': {}}).encode())
            time.sleep(0.2)
            self.assertEqual(order, ['start-1'], '第二个重操作必须等第一个完成（串行）')
            gate.set()
            deadline = time.monotonic() + 5
            while len(self._parsed()) < 2 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(order, ['start-1', 'end-1', 'start-2'])
            results = {r['id']: r['result'] for r in self._parsed()}
            self.assertEqual(results, {'a': 'one', 'b': 'two'})
        finally:
            gate.set()
            pool.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
