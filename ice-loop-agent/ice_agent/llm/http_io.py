"""Bounded cancellable HTTP I/O; callbacks and SQLite stay in the caller thread."""
from __future__ import annotations

import asyncio
import contextvars
import functools
import queue
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import httpx
import httpcore

from .errors import ModelError, NetworkError, RequestTimeoutError

_cancelled = contextvars.ContextVar('ice_model_request_cancelled', default=None)
_scheduler = None
_scheduler_lock = threading.Lock()


@contextmanager
def request_control(cancelled):
    parent = _cancelled.get()
    combined = (lambda: bool(cancelled() or parent())) if cancelled and parent else cancelled or parent
    token = _cancelled.set(combined)
    try:
        yield
    finally:
        _cancelled.reset(token)


class _Resolver(ThreadPoolExecutor):
    """Bound non-cancellable OS DNS/certificate setup to two operations, no backlog."""
    def __init__(self):
        super().__init__(max_workers=2, thread_name_prefix='ice-http-dns')
        self.slots = threading.BoundedSemaphore(2)

    def submit(self, fn, /, *args, **kwargs):
        if not self.slots.acquire(blocking=False):
            raise NetworkError('网络初始化仍在处理中，请稍后重试')
        try:
            future = super().submit(fn, *args, **kwargs)
        except BaseException:
            self.slots.release()
            raise
        future.add_done_callback(lambda _: self.slots.release())
        return future


class _Scheduler:
    def __init__(self):
        self.ready = threading.Event()
        self.active = 0
        self.thread = threading.Thread(target=self._run, name='ice-http-io', daemon=True)
        self.thread.start()
        self.ready.wait()

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.set_default_executor(_Resolver())
        self.slots = asyncio.Semaphore(2)
        self.ready.set()
        self.loop.run_forever()


def scheduler():
    global _scheduler
    with _scheduler_lock:
        if _scheduler is None:
            _scheduler = _Scheduler()
        return _scheduler


def exchange(base_url, suffix, *, method, headers, body=None, timeout=120, allow_loopback=False):
    """Yield headers/raw bytes. Queue holds <=32KiB plus a bounded network chunk."""
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
        raise ValueError('网络总时限需为0–3600秒')
    control = _cancelled.get()
    def check():
        if control and control():
            raise ModelError('CANCELLED', '请求已停止；远端已处理的部分仍可能产生费用')
    check()
    deadline = time.monotonic() + timeout
    events = queue.Queue(maxsize=2)
    started, cleaned = threading.Event(), threading.Event()
    owner = scheduler()
    space = None

    async def emit(event):
        while True:
            try:
                events.put_nowait(event)
                return
            except queue.Full:
                space.clear()
                if not events.full():continue
                await space.wait()

    async def transfer():
        nonlocal space
        space = asyncio.Event()
        started.set()
        try:
            async with asyncio.timeout(max(0, deadline-time.monotonic())):
                async with owner.slots:
                    owner.active += 1
                    try:
                        # Syntax, DNS/private-address and redirect rules are unchanged.
                        from .transport import validate_endpoint
                        endpoint = await owner.loop.run_in_executor(None, functools.partial(
                            validate_endpoint, base_url, allow_loopback_http=allow_loopback))
                        # Match urllib's system certificate trust and configured proxies.
                        trust = await owner.loop.run_in_executor(None, ssl.create_default_context)
                        from .http_backend import OwnedHTTPTransport, configured_proxy
                        proxy = await owner.loop.run_in_executor(None, functools.partial(configured_proxy,endpoint,allow_loopback=allow_loopback))
                        async with httpx.AsyncClient(transport=OwnedHTTPTransport(trust,proxy), follow_redirects=False,
                                trust_env=False, timeout=timeout) as client:
                            async with client.stream(method, endpoint+suffix, headers=headers, content=body) as response:
                                await emit(('headers', (response.status_code, dict(response.headers))))
                                async for chunk in response.aiter_raw():
                                    for start in range(0, len(chunk), 16384):
                                        await emit(('data', chunk[start:start+16384]))
                        await emit(('end', None))
                    finally:
                        owner.active -= 1
        except asyncio.CancelledError:
            raise
        except (TimeoutError, httpx.TimeoutException, httpcore.TimeoutException):
            await emit(('error', RequestTimeoutError('网络请求超过总时限，连接已关闭；可调整范围后重试')))
        except ModelError as exc:
            await emit(('error', exc))
        except httpx.HTTPError as exc:
            await emit(('error', NetworkError(f'网络请求失败：{type(exc).__name__}')))
        except Exception as exc:
            await emit(('error', NetworkError(f'网络处理失败：{type(exc).__name__}')))
        finally:
            cleaned.set()

    future = asyncio.run_coroutine_threadsafe(transfer(), owner.loop)
    try:
        while True:
            check()
            if time.monotonic() >= deadline:
                raise RequestTimeoutError('网络请求超过总时限，连接已关闭；可调整范围后重试')
            try:
                kind, value = events.get(timeout=min(.1, max(.001, deadline-time.monotonic())))
            except queue.Empty:
                continue
            check()
            if space is not None:owner.loop.call_soon_threadsafe(space.set)
            if kind == 'error':
                raise value
            if kind == 'end':
                return
            yield kind, value
    finally:
        future.cancel()
        if started.is_set() and not cleaned.wait(2):
            raise ModelError('NETWORK_CLEANUP_PENDING', '网络连接仍在关闭，请稍后再试')
