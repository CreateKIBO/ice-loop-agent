"""v3.22 公众号接口与草稿箱同步的 RPC。AppSecret 由桌面主进程加密保存，经 secrets.set 只放在引擎内存里。"""
from __future__ import annotations

from contextlib import closing
from typing import Any

from . import Handler, register

METHODS = frozenset({'wechat.status', 'wechat.configure', 'wechat.test', 'wechat.draft_sync', 'wechat.resolve_unknown',
                       'wechat.group_preview', 'wechat.group_sync'})


@register
class WeChatHandler(Handler):
    METHODS = METHODS

    def handle(self, method: str, params: dict) -> Any:
        from ..domain.store import Store
        from ..wechat.sync import WeChatDrafts
        account = self.service._account()
        if params.get('account_id') not in (None, account['id']):
            raise ValueError('公众号已切换，请刷新后重试')
        with closing(Store(self.service.runtime / 'app.db')) as store:
            drafts = WeChatDrafts(self.service, store, account)
            return getattr(drafts, method.split('.', 1)[1])(params)
