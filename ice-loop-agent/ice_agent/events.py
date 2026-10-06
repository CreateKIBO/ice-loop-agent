"""v2 持久事件流代理（M1-05，报告 §7.2）。

职责：
- 每条状态事件先入 stream_events（Store），sequence 单调，可按游标回放；
- 模型 token 级 delta 在代理内按 (stream, turn) 合并批量投递（默认 80ms 窗口），
  不逐 token 产生数据库事务；最终完整文本由业务层持久化并附带最终事件；
- 事件经 RpcChannel 输出（kind=event），断线的客户端用 events.poll 按
  after_sequence 补取，重复 sequence 客户端忽略。

订阅断开不丢事件：一切以 SQLite 为准，代理只是分发器。
"""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any

DELTA_FLUSH_SECONDS = 0.08
DELTA_FLUSH_CHARS = 400


class EventBroker:
    def __init__(self, store_factory, emit=None, *,
                 delta_window: float = DELTA_FLUSH_SECONDS,
                 delta_chars: int = DELTA_FLUSH_CHARS):
        """store_factory() -> Store（每线程独立连接）。emit(dict) 输出一行事件。"""
        self._store_factory = store_factory
        self._emit = emit or (lambda event: None)
        self._delta_window = delta_window
        self._delta_chars = delta_chars
        self._lock = threading.Lock()
        self._buffers: dict[tuple[str, str], dict[str, Any]] = {}

    # ------------------------------------------------------------- 直接事件
    def publish(self, stream_id: str, account_id: str, event_type: str,
                payload: dict[str, Any] | None = None) -> dict[str, Any]:
        store = self._store_factory()
        try:
            record = store.append_stream_event(stream_id, account_id, event_type,
                                               payload or {},
                                               event_id=f"evt-{uuid.uuid4().hex[:20]}")
        finally:
            store.close()
        self._emit({"event_id": record["event_id"], "stream_id": stream_id,
                    "account_id": account_id, "sequence": record["sequence"],
                    "type": event_type, "payload": record["payload"]})
        return record

    # ------------------------------------------------------------- delta 合并
    def publish_delta(self, stream_id: str, account_id: str, turn_id: str,
                      attempt_id: str, text: str) -> None:
        key = (stream_id, turn_id)
        flush_now = False
        with self._lock:
            buffer = self._buffers.get(key)
            if buffer is None:
                buffer = {"account_id": account_id, "attempt_id": attempt_id,
                          "text": "", "started": time.monotonic()}
                self._buffers[key] = buffer
            buffer["text"] += text
            flush_now = (len(buffer["text"]) >= self._delta_chars
                         or time.monotonic() - buffer["started"] >= self._delta_window)
            if flush_now:
                self._buffers.pop(key, None)
        if flush_now:
            self._flush_delta(stream_id, turn_id, buffer)

    def flush_delta(self, stream_id: str, turn_id: str) -> None:
        with self._lock:
            buffer = self._buffers.pop((stream_id, turn_id), None)
        if buffer:
            self._flush_delta(stream_id, turn_id, buffer)

    def _flush_delta(self, stream_id: str, turn_id: str, buffer: dict[str, Any]) -> None:
        if buffer["text"]:
            self.publish(stream_id, buffer["account_id"], "model.delta", {
                "turn_id": turn_id, "attempt_id": buffer["attempt_id"],
                "text": buffer["text"]})


def dedupe_by_sequence(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[int]]:
    """客户端侧回放语义：丢弃重复 sequence，返回 (去重结果, 缺口号)。"""
    seen: set[int] = set()
    unique: list[dict[str, Any]] = []
    for event in sorted(events, key=lambda e: e["sequence"]):
        if event["sequence"] in seen:
            continue
        seen.add(event["sequence"])
        unique.append(event)
    gaps: list[int] = []
    for previous, current in zip(unique, unique[1:]):
        if current["sequence"] != previous["sequence"] + 1:
            gaps.extend(range(previous["sequence"] + 1, current["sequence"]))
    return unique, gaps
