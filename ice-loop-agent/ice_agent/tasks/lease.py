"""Own-connection lease renewal while an engine waits on IO or executes a node."""
from __future__ import annotations

import threading

from . import TaskQueue
from ..domain.store import Store


class TaskLease:
    def __init__(self, db_path, task_id, token, *, lease_seconds=120,
                 stop_event=None, poll_seconds=1.0):
        self.db_path,self.task_id,self.token = db_path,task_id,token
        self.lease_seconds = lease_seconds
        self.stop_event = stop_event
        self.interval = min(poll_seconds,max(0.05,lease_seconds/3))
        self.lost = threading.Event()
        self.cancelled = threading.Event()
        self.error: str | None = None
        self._ready,self._closed = threading.Event(),threading.Event()
        self._thread = threading.Thread(target=self._watch,daemon=True,name='ice-task-lease')

    def should_stop(self):
        return (self.lost.is_set() or self.cancelled.is_set()
                or self.stop_event is not None and self.stop_event.is_set())

    def __enter__(self):
        self._thread.start()
        if not self._ready.wait(6):
            self.error = 'LEASE_MONITOR_START_TIMEOUT'
            self.lost.set()
        return self

    def __exit__(self,*_):
        self._closed.set()
        self._thread.join(timeout=6)
        if self._thread.is_alive():
            self.error = 'LEASE_MONITOR_CLOSE_TIMEOUT'
            self.lost.set()

    def _pause_owned_job(self,store,queue):
        queue.pause_bound_job(self.task_id,self.token,
            '队列取消或程序关闭；当前远端请求费用可能仍产生')

    def _watch(self):
        store = None
        try:
            store = Store(self.db_path)
            store.conn.execute('PRAGMA busy_timeout=1000')
            queue = TaskQueue(store,lease_seconds=self.lease_seconds)
            while not self._closed.is_set():
                # A lost token never pauses a job: it may already have a new owner.
                if not queue.heartbeat(self.task_id,self.token):
                    self.lost.set()
                    break
                current = queue.get(self.task_id)
                if current['cancel_requested']:
                    self.cancelled.set()
                if self.cancelled.is_set() or self.stop_event is not None and self.stop_event.is_set():
                    self._pause_owned_job(store,queue)
                self._ready.set()
                if self._closed.wait(self.interval):
                    break
        except Exception as error:
            # No credentials/content in diagnostics. The worker records a stable code.
            self.error = type(error).__name__
            self.lost.set()
        finally:
            self._ready.set()
            if store is not None: store.close()
