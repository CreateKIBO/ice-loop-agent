"""v3 普通文章 RPC（A-01/A-02/A-03/B-03/B-04/C-02/C-04/C-05）。

不需要 jobId、模型、栏目或期号；所有调用按当前公众号校验。
documents.copy_payload / documents.delivery_record / documents.image_import 只供
桌面主进程调用（渲染层白名单不含这些方法）。
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any

from . import Handler, register

PUBLIC = frozenset({
    'documents.list', 'documents.create', 'documents.get', 'documents.save_working', 'documents.commit_version',
    'documents.versions', 'documents.version', 'documents.restore', 'documents.update_meta', 'documents.trash',
    'documents.untrash', 'documents.delete_forever', 'documents.skill_binding', 'documents.duplicate', 'documents.markdown', 'documents.open_legacy',
    'documents.convert_paste', 'documents.import_paste', 'documents.import_original', 'documents.reconvert',
    'documents.image_import_data', 'documents.image_view', 'documents.images_library',
    'documents.image_edit', 'documents.image_source_update', 'documents.import_docx',
    'documents.batch', 'documents.plan', 'documents.calendar', 'documents.suggestions', 'documents.suggestions_dismiss',
    'documents.library', 'documents.image_tags',
    'documents.compat_create', 'documents.compat_get', 'documents.compat_record', 'documents.compat_report',
    'documents.perf_sample',
    'documents.trial_start', 'documents.trial_stop', 'documents.trial_note', 'documents.trial_status', 'documents.trial_report',
    'documents.render_delivery', 'documents.export_bundle',
    'documents.from_candidate', 'documents.ai_draft_start', 'documents.ai_guided_start', 'documents.variants',
    'documents.assist_start', 'documents.assist_list', 'documents.assist_get', 'documents.assist_cancel',
    'documents.assist_apply', 'documents.assist_dismiss', 'documents.assist_revert', 'documents.assist_search',
    'publications.register', 'publications.list', 'publications.withdraw',
    'bookmarks.list', 'bookmarks.save', 'bookmarks.remove', 'bookmarks.reorder', 'bookmarks.restore_defaults',
})
# P1 生成模式提示：随需求一并发送，用户在助手会话里可以看到原文。
QUICK_HINT = '\n\n（快速生成：不要提问；信息不足时按合理默认补全，直接写出完整初稿。）'
GUIDED_HINT = ('\n\n（引导模式：先用提问框确认最影响成稿的 2–4 个问题，例如读者、篇幅、角度、必须包含的要点，'
               '每题给出选项；我回答后再写完整初稿。）')
VARIANT_B_HINT = '\n（这是第二个版本：换一个切入角度、开头和结构，与另一版明显不同，但遵守同样的需求。）'
MAIN_ONLY = frozenset({'documents.copy_payload', 'documents.delivery_record', 'documents.image_import',
                       'documents.long_image_page', 'documents.long_image_compose', 'documents.svg_import'})

_ROUTES = {
    'documents.list': 'list', 'documents.create': 'create', 'documents.get': 'get',
    'documents.save_working': 'save_working', 'documents.commit_version': 'commit_version',
    'documents.versions': 'versions', 'documents.version': 'version', 'documents.restore': 'restore',
    'documents.update_meta': 'update_meta', 'documents.trash': 'trash', 'documents.untrash': 'restore_trashed',
    'documents.delete_forever': 'delete_forever', 'documents.skill_binding': 'skill_binding',
    'documents.duplicate': 'duplicate', 'documents.markdown': 'markdown', 'documents.open_legacy': 'open_legacy',
    'documents.convert_paste': 'convert_paste', 'documents.import_paste': 'import_paste', 'documents.import_original': 'import_original',
    'documents.reconvert': 'reconvert', 'documents.image_import_data': 'image_import_data',
    'documents.image_import': 'image_import', 'documents.image_view': 'image_view',
    'documents.images_library': 'images_library', 'documents.image_edit': 'image_edit',
    'documents.image_source_update': 'image_source_update', 'documents.import_docx': 'import_docx', 'documents.render_delivery': 'render_delivery',
    'documents.copy_payload': 'copy_payload', 'documents.delivery_record': 'delivery_record',
    'documents.long_image_page': 'long_image_page', 'documents.long_image_compose': 'long_image_compose',
    'documents.compat_create': 'compat_create', 'documents.compat_get': 'compat_get',
    'documents.compat_record': 'compat_record', 'documents.compat_report': 'compat_report', 'documents.perf_sample': 'perf_sample',
    'documents.svg_import': 'svg_import',
    'documents.export_bundle': 'export_bundle', 'documents.from_candidate': 'from_candidate', 'documents.variants': 'variants',
    'publications.register': 'register_publication', 'publications.list': 'publications',
    'publications.withdraw': 'withdraw_publication',
    'bookmarks.list': 'bookmarks', 'bookmarks.save': 'bookmark_save', 'bookmarks.remove': 'bookmark_remove',
    'bookmarks.reorder': 'bookmark_reorder', 'bookmarks.restore_defaults': 'bookmark_restore_defaults',
}
# P2 运营增强（ice_agent/documents/ops.py）
_OPS = {
    'documents.batch': 'batch', 'documents.plan': 'plan', 'documents.calendar': 'calendar',
    'documents.suggestions': 'suggestions', 'documents.suggestions_dismiss': 'dismiss_suggestions',
    'documents.library': 'library', 'documents.image_tags': 'tag',
}
# v3.13 作者试用记录（ice_agent/documents/trial.py）
_TRIAL = {'documents.trial_start': 'start', 'documents.trial_stop': 'stop', 'documents.trial_note': 'note',
          'documents.trial_status': 'status', 'documents.trial_report': 'report'}


def _assist_apply(params: dict, result: dict) -> dict:
    proposal = result.get('proposal') or {}
    return {'document_id': proposal.get('document_id'), 'accepted': len(result.get('applied') or []),
            'total': len(proposal.get('ops') or []), 'stale': len(result.get('stale') or [])}


def _proposal_doc(params: dict, result: dict) -> dict:
    proposal = result.get('proposal') if 'proposal' in result else result
    return {'document_id': (proposal or {}).get('document_id'), 'action': str((proposal or {}).get('action', ''))[:20]}


_TRIAL_EVENTS: dict = {
    'documents.create': ('doc_created', lambda p, r: {'kind': str(p.get('kind', 'blank'))[:20]}),
    'documents.import_paste': ('paste', lambda p, r: {'mode': str(p.get('mode', 'adapt'))[:10]}),
    'documents.import_docx': ('import_docx', lambda p, r: {'images': int(((r.get('report') or {}).get('images') or {}).get('imported', 0))}),
    'documents.ai_draft_start': ('ai_draft', lambda p, r: {'variants': int(p.get('variants', 1)) if p.get('variants') in (1, 2) else 1}),
    'documents.ai_guided_start': ('ai_guided', lambda p, r: {}),
    'documents.assist_start': ('assist_start', lambda p, r: {'document_id': r.get('document_id'), 'action': str(r.get('action', ''))[:20]}),
    'documents.assist_apply': ('assist_apply', _assist_apply),
    'documents.assist_dismiss': ('assist_dismiss', _proposal_doc),
    'documents.assist_revert': ('assist_revert', _proposal_doc),
    'documents.delivery_record': ('delivery', lambda p, r: {'kind': str(p.get('kind', ''))[:20]}),
    'documents.export_bundle': ('export', lambda p, r: {'images': int(r.get('images', 0) or 0)}),
    'publications.register': ('publication', lambda p, r: {}),
    'documents.commit_version': ('version', lambda p, r: {'created': bool(r.get('created'))}),
    'documents.restore': ('restore', lambda p, r: {}),
    'documents.convert_paste': ('paste', lambda p, r: {'mode': str(p.get('mode', 'adapt'))[:10], 'in_editor': True}),
}
_ASSIST = {
    'documents.assist_start': 'start', 'documents.assist_list': 'list', 'documents.assist_get': 'get',
    'documents.assist_cancel': 'cancel', 'documents.assist_apply': 'apply', 'documents.assist_dismiss': 'dismiss',
    'documents.assist_revert': 'revert', 'documents.assist_search': 'search',
}


@register
class DocumentsHandler(Handler):
    METHODS = PUBLIC | MAIN_ONLY

    @contextmanager
    def _store(self):
        """短时打开一个数据库连接（读技能设置、会话/提案归属等），用完即关。"""
        from ..domain.store import Store
        store = Store(self.service.runtime / 'app.db')
        try:
            yield store
        finally:
            store.close()

    def handle(self, method: str, params: dict) -> Any:
        account = self.service._account()
        if params.get('account_id') not in (None, account['id']):
            raise ValueError('公众号已切换，请刷新文章列表')
        if method in _TRIAL:
            from ..documents.trial import TrialLog
            from ..domain.store import Store
            store = Store(self.service.runtime / 'app.db')
            try:
                return getattr(TrialLog(store, account), _TRIAL[method])(params)
            finally:
                store.close()
        result = self._dispatch(account, method, params)
        if method in _TRIAL_EVENTS:
            self._trial_event(account, method, params, result)
        return result

    def _trial_event(self, account: dict, method: str, params: dict, result: Any) -> None:
        """作者试用记录：只在用户开启试用时记录操作类型与数量；记录失败不影响正常操作。"""
        try:
            from ..documents.trial import TrialLog
            from ..domain.store import Store
            kind, extract = _TRIAL_EVENTS[method]
            if kind == 'doc_created' and isinstance(params.get('kind'), str) and params.get('kind') not in ('blank', 'markdown'):
                return
            payload = extract(params, result if isinstance(result, dict) else {}) if extract else {}
            if payload is None:
                return
            document_id = payload.pop('document_id', None) or (result.get('document_id') if isinstance(result, dict) else None) \
                or params.get('document_id')
            store = Store(self.service.runtime / 'app.db')
            try:
                TrialLog(store, account).record(kind, document_id if isinstance(document_id, str) else None, **payload)
            finally:
                store.close()
        except Exception:  # noqa: BLE001 - 试用记录是旁路，不能让主操作失败
            pass

    def _dispatch(self, account: dict, method: str, params: dict) -> Any:
        if method == 'documents.ai_draft_start':
            return self._ai_draft(account, params)
        if method == 'documents.ai_guided_start':
            return self._ai_guided(account, params)
        if method in _ASSIST:
            return self._assist(account, method, params)
        if method in _OPS:
            from ..documents.ops import DocumentOps
            from ..domain.store import Store
            store = Store(self.service.runtime / 'app.db')
            try:
                return getattr(DocumentOps(self.service, store, account), _OPS[method])(params)
            finally:
                store.close()
        from ..documents.service import DocumentService
        from ..domain.store import Store
        store = Store(self.service.runtime / 'app.db')
        try:
            return getattr(DocumentService(self.service, store, account), _ROUTES[method])(params)
        finally:
            store.close()

    def _ai_draft(self, account: dict, params: dict) -> dict:
        """整篇生成（C-04 + P1 快速模式/两版对照）：先建“生成中”的独立文章，再经创作会话后台生成；不抢焦点。"""
        import re
        from ..documents.schema import DocumentError
        from ..documents.service import DocumentService
        from ..domain.store import Store
        variants = params.get('variants', 1)
        if variants not in (1, 2):
            raise DocumentError('一次最多生成两个版本')
        store = Store(self.service.runtime / 'app.db')
        try:
            documents = DocumentService(self.service, store, account)
            base = {k: v for k, v in params.items() if k not in ('variants', 'mode', 'variant', 'variant_group')}
            request_id = params.get('request_id')
            if variants == 2:
                if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,70}', request_id):
                    raise DocumentError('起草请求标识无效')
                plans = [({**base, 'request_id': request_id, 'variant': 'A', 'variant_group': 'vg-' + request_id}, ''),
                         ({**base, 'request_id': request_id + '_b', 'variant': 'B', 'variant_group': 'vg-' + request_id},
                          VARIANT_B_HINT)]
            else:
                plans = [(base, '')]
            ids = [self._draft_one(documents, plan, hint) for plan, hint in plans]
            detail = documents.get({'document_id': ids[0]})
            if variants == 2:
                detail['variant_documents'] = ids
            return detail
        finally:
            store.close()

    def _draft_one(self, documents: Any, params: dict, extra_hint: str) -> str:
        from ..creative_chat import CreativeChat
        started = documents.ai_draft_start(params)
        document = started['document']
        if not started['created']:
            return document['document_id']
        request_id = started['request_id']
        chat = CreativeChat(self.service)
        conversation_id = ''
        try:
            conversation = chat.call('chat.create', {'title': document['title'].replace('（生成中）', '')[:120],
                                                     'request_id': 'doc-' + request_id})
            conversation_id = conversation['conversation']['id'] if 'conversation' in conversation else conversation['id']
            send = {'conversation_id': conversation_id, 'text': document['meta']['brief'] + QUICK_HINT + extra_hint,
                    'mode': 'draft', 'request_id': 'docsend-' + request_id}
            if document['meta'].get('skill_binding'):  # v3.16：按本篇技能生成
                send['skill_selection'] = {'binding': document['meta']['skill_binding']}
            sent = chat.call('chat.send', send)
            if not sent.get('accepted') or sent.get('status') == 'failed':
                raise ValueError('生成任务未能启动，请检查模型配置后重试')
            documents.ai_draft_bind(document['document_id'], conversation_id, sent['message_id'], None)
        except Exception as error:  # 失败如实记录在文章上，不冒充完成
            documents.ai_draft_bind(document['document_id'], conversation_id, None, str(error) or '生成失败')
        return document['document_id']

    def _ai_guided(self, account: dict, params: dict) -> dict:
        """引导模式（P1）：在助手会话里先用提问框确认关键问题，再出初稿；用户满意后“存为文章”。"""
        import re
        from ..creative_chat import CreativeChat
        from ..documents.schema import DocumentError
        brief = params.get('brief')
        if not isinstance(brief, str) or not 4 <= len(brief.strip()) <= 4000:
            raise DocumentError('请用 4–4000 字描述要写的文章')
        request_id = params.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', request_id):
            raise DocumentError('起草请求标识无效')
        from ..skills import WritingSkills
        binding = None
        if params.get('skill_binding') is not None:  # v3.16：引导模式同样可选技能
            with self._store() as store:
                binding = WritingSkills(store, account).validate_binding(params['skill_binding'])
        chat = CreativeChat(self.service)
        conversation = chat.call('chat.create', {'title': re.sub(r'\s+', ' ', brief.strip())[:40], 'request_id': 'guide-' + request_id})
        conversation_id = conversation['conversation']['id'] if 'conversation' in conversation else conversation['id']
        if binding:  # v3.17：记为会话技能，回答问题后的继续写作与改稿沿用
            with self._store() as store:
                if store.conn.execute('SELECT 1 FROM creative_conversations WHERE id=? AND account_id=?', (conversation_id, account['id'])).fetchone():
                    WritingSkills(store, account).conversation_binding({'conversation_id': conversation_id, 'binding': binding})
        send = {'conversation_id': conversation_id, 'text': brief.strip() + GUIDED_HINT,
                'mode': 'draft', 'request_id': 'guidesend-' + request_id}
        if binding:
            send['skill_selection'] = {'binding': binding}
        sent = chat.call('chat.send', send)
        if not sent.get('accepted') or sent.get('status') == 'failed':
            raise DocumentError('引导式起草未能启动，请检查模型配置后重试')
        return {'conversation_id': conversation_id, 'message_id': sent.get('message_id')}

    # ------------------------------------------------ P1-01 文章内助手提案链
    def _assist(self, account: dict, method: str, params: dict) -> Any:
        import copy
        from ..documents.assist import DocumentAssist
        from ..domain.store import Store
        store = Store(self.service.runtime / 'app.db')
        try:
            def submit(proposal_id: str, request: dict, cancel: Any) -> None:
                self.service.workers.submit(self._assist_worker, copy.deepcopy(account), proposal_id, request, cancel)
            return getattr(DocumentAssist(self.service, store, account, submit=submit), _ASSIST[method])(params)
        finally:
            store.close()

    def _assist_worker(self, account: dict, proposal_id: str, request: dict, cancel: Any) -> None:
        from ..documents.assist import DocumentAssist, release
        from ..domain.store import Store
        try:
            # v3.16：助手按这篇文章的技能（本篇 → 系列 → 公众号）解析，而不是只看公众号默认。
            from ..skills import selection_for_document
            with self._store() as probe:
                row = probe.conn.execute('SELECT document_id FROM document_proposals WHERE proposal_id=? AND account_id=?',
                                         (proposal_id, account['id'])).fetchone()
                selection = selection_for_document(probe, account['id'], row['document_id']) if row else None
            engine, cfg, store = self.service._app(account_id=account['id'], skill_selection=selection)
        except Exception as error:  # 模型/账号配置不可用：如实记在提案上
            release(proposal_id)
            store = Store(self.service.runtime / 'app.db')
            try:
                DocumentAssist(self.service, store, account)._finish(proposal_id, error=str(error) or '助手无法启动')
            finally:
                store.close()
            return
        try:
            engine.router.cancelled = cancel.is_set
            DocumentAssist(self.service, store, account).run(
                proposal_id, request, lambda req: engine.router.generate(req, max_attempts=1), profile=cfg.profile)
        finally:
            store.close()
