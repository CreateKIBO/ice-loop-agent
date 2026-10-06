"""v2.0 持久事件流测试（M1-05）：sequence 单调、游标回放、delta 合并、账号校验。"""
from __future__ import annotations

import json
import threading
import unittest

from ice_agent.domain.store import Store
from ice_agent.events import EventBroker, dedupe_by_sequence
from tests import temp_dir


class TestStreamEvents(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir('v2events-')
        self.store = Store(self.dir / 'app.db')

    def tearDown(self):
        self.store.close()

    def test_sequence_monotonic_and_replay_from_cursor(self):
        emitted = []
        broker = EventBroker(lambda: Store(self.dir / 'app.db'), emit=emitted.append)
        for i in range(5):
            broker.publish('conv-1', 'ice-loop', 'turn.started', {'n': i})
        self.assertEqual([e['sequence'] for e in emitted], [1, 2, 3, 4, 5])
        # 从游标 2 回放：只返回 3..5；重复拉取结果一致（幂等）
        store = Store(self.dir / 'app.db')
        try:
            first = store.stream_events_after('conv-1', 2)
            again = store.stream_events_after('conv-1', 2)
            self.assertEqual([e['sequence'] for e in first], [3, 4, 5])
            self.assertEqual(first, again)
            latest = store.latest_stream_sequence('conv-1')
            self.assertEqual(latest, 5)
        finally:
            store.close()

    def test_concurrent_publish_no_lost_or_duplicate_sequence(self):
        broker = EventBroker(lambda: Store(self.dir / 'app.db'), emit=lambda e: None)
        errors: list[Exception] = []

        def worker(n):
            try:
                for i in range(10):
                    broker.publish('race-stream', 'ice-loop', 'model.delta', {'w': n, 'i': i})
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        store = Store(self.dir / 'app.db')
        try:
            events = store.stream_events_after('race-stream', 0, limit=100)
            sequences = [e['sequence'] for e in events]
            self.assertEqual(sequences, list(range(1, 41)), '40 条事件 sequence 连续无重复')
        finally:
            store.close()

    def test_delta_batching_merges_burst(self):
        emitted = []
        broker = EventBroker(lambda: Store(self.dir / 'app.db'), emit=emitted.append,
                             delta_window=60.0)  # 窗口极大：全部合并直到 flush
        for i in range(10):
            broker.publish_delta('conv-2', 'ice-loop', 'turn-1', 'att-1', f'片段{i}')
        self.assertEqual(emitted, [], '窗口内不应逐片投递')
        broker.flush_delta('conv-2', 'turn-1')
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]['type'], 'model.delta')
        self.assertEqual(emitted[0]['payload']['text'], ''.join(f'片段{i}' for i in range(10)))
        # 已 flush 的 turn 再次 flush 不产生空事件
        broker.flush_delta('conv-2', 'turn-1')
        self.assertEqual(len(emitted), 1)

    def test_delta_chars_threshold_flushes_immediately(self):
        emitted = []
        broker = EventBroker(lambda: Store(self.dir / 'app.db'), emit=emitted.append,
                             delta_window=60.0, delta_chars=5)
        broker.publish_delta('conv-3', 'ice-loop', 't', 'a', 'x' * 5)
        self.assertEqual(len(emitted), 1, '达到字符阈值立即批量投递')


class TestReplaySemantics(unittest.TestCase):
    def test_dedupe_and_gap_detection(self):
        events = [
            {'sequence': 1, 'type': 'a', 'payload': {}},
            {'sequence': 3, 'type': 'c', 'payload': {}},
            {'sequence': 2, 'type': 'b', 'payload': {}},
            {'sequence': 2, 'type': 'b-dup', 'payload': {}},
        ]
        unique, gaps = dedupe_by_sequence(events)
        self.assertEqual([e['sequence'] for e in unique], [1, 2, 3])
        self.assertEqual([e['type'] for e in unique], ['a', 'b', 'c'], '重复 sequence 首个保留')
        self.assertEqual(gaps, [])


if __name__ == '__main__':
    unittest.main()
