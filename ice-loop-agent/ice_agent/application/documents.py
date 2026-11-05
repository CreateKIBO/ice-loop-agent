"""v3 普通文章 RPC（A-01/A-02/A-03/B-03/B-04/C-02/C-04/C-05）。

不需要 jobId、模型、栏目或期号；所有调用按当前公众号校验。
documents.copy_payload / documents.delivery_record / documents.image_import 只供
桌面主进程调用（渲染层白名单不含这些方法）。
"""
from __future__ import annotations

from typing import Any

from . import Handler, register

PUBLIC = frozenset({
    'documents.list', 'documents.create', 'documents.get', 'documents.save_working', 'documents.commit_version',
    'documents.versions', 'documents.version', 'documents.restore', 'documents.update_meta', 'documents.trash',
    'documents.untrash', 'documents.duplicate', 'documents.markdown', 'documents.open_legacy',
    'documents.convert_paste', 'documents.import_paste', 'documents.import_original', 'documents.reconvert',
    'documents.image_import_data', 'documents.image_view', 'documents.images_library',
    'documents.render_delivery', 'documents.export_bundle',
    'documents.from_candidate', 'documents.ai_draft_start',
    'publications.register', 'publications.list', 'publications.withdraw',
    'bookmarks.list', 'bookmarks.save', 'bookmarks.remove', 'bookmarks.reorder', 'bookmarks.restore_defaults',
})
MAIN_ONLY = frozenset({'documents.copy_payload', 'documents.delivery_record', 'documents.image_import'})

_ROUTES = {
    'documents.list': 'list', 'documents.create': 'create', 'documents.get': 'get',
    'documents.save_working': 'save_working', 'documents.commit_version': 'commit_version',
    'documents.versions': 'versions', 'documents.version': 'version', 'documents.restore': 'restore',
    'documents.update_meta': 'update_meta', 'documents.trash': 'trash', 'documents.untrash': 'restore_trashed',
    'documents.duplicate': 'duplicate', 'documents.markdown': 'markdown', 'documents.open_legacy': 'open_legacy',
    'documents.convert_paste': 'convert_paste', 'documents.import_paste': 'import_paste', 'documents.import_original': 'import_original',
    'documents.reconvert': 'reconvert', 'documents.image_import_data': 'image_import_data',
    'documents.image_import': 'image_import', 'documents.image_view': 'image_view',
    'documents.images_library': 'images_library', 'documents.render_delivery': 'render_delivery',
    'documents.copy_payload': 'copy_payload', 'documents.delivery_record': 'delivery_record',
    'documents.export_bundle': 'export_bundle', 'documents.from_candidate': 'from_candidate',
    'publications.register': 'register_publication', 'publications.list': 'publications',
    'publications.withdraw': 'withdraw_publication',
    'bookmarks.list': 'bookmarks', 'bookmarks.save': 'bookmark_save', 'bookmarks.remove': 'bookmark_remove',
    'bookmarks.reorder': 'bookmark_reorder', 'bookmarks.restore_defaults': 'bookmark_restore_defaults',
}


@register
class DocumentsHandler(Handler):
    METHODS = PUBLIC | MAIN_ONLY

    def handle(self, method: str, params: dict) -> Any:
        account = self.service._account()
        if params.get('account_id') not in (None, account['id']):
            raise ValueError('公众号已切换，请刷新文章列表')
        if method == 'documents.ai_draft_start':
            return self._ai_draft(account, params)
        from ..documents.service import DocumentService
        from ..domain.store import Store
        store = Store(self.service.runtime / 'app.db')
        try:
            return getattr(DocumentService(self.service, store, account), _ROUTES[method])(params)
        finally:
            store.close()

    def _ai_draft(self, account: dict, params: dict) -> dict:
        """整篇生成（C-04）：先建“生成中”的独立文章，再经创作会话后台生成；不抢焦点。"""
        from ..creative_chat import CreativeChat
        from ..documents.service import DocumentService
        from ..domain.store import Store
        store = Store(self.service.runtime / 'app.db')
        try:
            documents = DocumentService(self.service, store, account)
            started = documents.ai_draft_start(params)
            document = started['document']
            if not started['created']:
                return documents.get({'document_id': document['document_id']})
            request_id = started['request_id']
            chat = CreativeChat(self.service)
            conversation_id = ''
            try:
                conversation = chat.call('chat.create', {'title': document['title'].replace('（生成中）', '')[:120],
                                                         'request_id': 'doc-' + request_id})
                conversation_id = conversation['conversation']['id'] if 'conversation' in conversation else conversation['id']
                sent = chat.call('chat.send', {'conversation_id': conversation_id, 'text': document['meta']['brief'],
                                               'mode': 'draft', 'request_id': 'docsend-' + request_id})
                if not sent.get('accepted') or sent.get('status') == 'failed':
                    raise ValueError('生成任务未能启动，请检查模型配置后重试')
                documents.ai_draft_bind(document['document_id'], conversation_id, sent['message_id'], None)
            except Exception as error:  # 失败如实记录在文章上，不冒充完成
                documents.ai_draft_bind(document['document_id'], conversation_id, None, str(error) or '生成失败')
            return documents.get({'document_id': document['document_id']})
        finally:
            store.close()
