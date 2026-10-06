"""应用服务 handler 层（M1-03）。

DesktopService.call 仍是唯一门面；这里按业务域提取 handler。
每个 handler 只做参数校验+账号校验+委托领域服务，不复制写入逻辑。
"""
from __future__ import annotations

from typing import Any, Callable


class Handler:
    """子类提供 METHODS 集合与 handle(method, params)。"""
    METHODS: frozenset[str] = frozenset()

    def __init__(self, service: Any):
        self.service = service

    def handle(self, method: str, params: dict) -> Any:  # pragma: no cover - interface
        raise NotImplementedError


_HANDLER_GROUPS: list[type[Handler]] = []


def register(cls: type[Handler]) -> type[Handler]:
    _HANDLER_GROUPS.append(cls)
    return cls


def dispatch_handlers(service: Any, method: str, params: dict) -> Callable[[], Any] | None:
    """返回可调用或 None（未命中）。门面负责调用。"""
    for cls in _HANDLER_GROUPS:
        if method in cls.METHODS:
            return cls(service).handle_bound(method, params)
    return None


@register
class EventsHandler(Handler):
    """事件流查询（M1-05）。从 desktop_service 提取，账号校验保持一致。"""

    METHODS = frozenset({'events.poll', 'events.latest'})

    def handle_bound(self, method: str, params: dict) -> Any:
        return getattr(self.service, method.replace('.', '_'))(params)
