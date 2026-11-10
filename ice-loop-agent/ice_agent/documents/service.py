"""普通文章服务：统一索引、旧数据映射、粘贴导入、图片、交付、收藏与人工发布登记。

所有方法按“当前公众号”校验；不需要模型、栏目或期号即可完成手动流程。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import html as htmllib
import io
import json
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from ..domain.types import new_id, now_iso, sha256_json, sha256_text
from .html_import import convert_html, convert_text
from .markdown_io import content_to_md, md_to_content
from .render import Renderer, delivery_hash, image_data_url
from .schema import DocumentError, normalize, normalize_style
from .store import DocumentStore, WorkingConflict

DEFAULT_BOOKMARKS = (
    ('https://mp.weixin.qq.com/', '微信公众平台'),
    ('https://app.tapnow.media/home', 'TapNow'),
)
_DATA_URL = re.compile(r'^data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$', re.I)


def _safe_https(url: Any) -> str:
    if not isinstance(url, str) or len(url) > 2000:
        raise DocumentError('请输入有效的 HTTPS 网址')
    url = url.strip()
    if '://' not in url:
        url = 'https://' + url
    parts = urlsplit(url)
    if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password \
            or parts.hostname in ('localhost', '127.0.0.1', '[::1]', '::1'):
        raise DocumentError('收藏只支持公开的 HTTPS 网址')
    return url


def _file_name(text: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f\s]+', '_', text).strip('._')
    return cleaned[:40] or '图片'


class DocumentService:
    def __init__(self, service: Any, store: Any, account: dict):
        self.service = service
        self.store = store
        self.account = account
        self.docs = DocumentStore(store, account['id'])
        from ..workspace_assets import WorkspaceAssets
        self.assets = WorkspaceAssets(store, service.runtime, account['id'])

    def _has_table(self, name: str) -> bool:
        return bool(self.store.conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())

    # ================================================================ index
    def list(self, params: dict) -> dict:
        lifecycle = params.get('lifecycle', 'active')
        if lifecycle not in ('active', 'trashed'):
            raise DocumentError('请选择文章或回收站')
        query = str(params.get('query', ''))[:200]
        self.reconcile_generations()
        documents = self.docs.list(lifecycle=lifecycle, query=query)
        legacy = self.legacy_items(query) if lifecycle == 'active' and params.get('include_legacy', True) else []
        return {'documents': documents, 'legacy': legacy, 'account_id': self.account['id']}

    def legacy_items(self, query: str = '') -> list[dict]:
        mapped = self.docs.mapped_refs()
        items = []
        for draft in self.assets.drafts():
            if ('legacy_draft', draft['draft_id']) in mapped:
                continue
            items.append({'id': 'legacy_draft:' + draft['draft_id'], 'kind': 'legacy_draft', 'origin': 'legacy_draft',
                          'origin_ref': draft['draft_id'], 'title': draft['title'], 'updated_at': draft['updated_at'],
                          'series': None, 'episode': None, 'source_label': '旧草稿', 'readonly': True})
        from ..task_lifecycle import task_is_hidden
        rows = self.store.conn.execute(
            'SELECT j.job_id, j.state, j.current_node, j.updated_at, a.topic, a.final_title, a.series, a.episode, a.spec_json'
            ' FROM jobs j JOIN articles a ON a.article_id=j.article_id ORDER BY j.updated_at DESC').fetchall()
        for row in rows:
            spec = json.loads(row['spec_json'])
            if spec.get('account_id', 'ice-loop') != self.account['id'] or spec.get('demo') or spec.get('image_only'):
                continue
            if ('legacy_job', row['job_id']) in mapped or task_is_hidden(self.store, row['job_id']):
                continue
            items.append({'id': 'legacy_job:' + row['job_id'], 'kind': 'legacy_job', 'origin': 'legacy_job',
                          'origin_ref': row['job_id'], 'title': row['final_title'] or row['topic'],
                          'updated_at': row['updated_at'], 'series': row['series'], 'episode': row['episode'],
                          'state': row['state'], 'source_label': '旧制作任务', 'readonly': True})
        query = query.casefold()
        return [i for i in items if not query or query in i['title'].casefold()]

    def open_legacy(self, params: dict) -> dict:
        origin, ref = params.get('origin'), params.get('origin_ref')
        if origin not in ('legacy_draft', 'legacy_job') or not isinstance(ref, str) or not ref:
            raise DocumentError('旧文章来源无效')
        existing = self.docs.mapped_refs().get((origin, ref))
        if existing:
            return self.docs.get(existing)
        if origin == 'legacy_draft':
            draft = self.assets.draft(ref)
            content = md_to_content(draft['body'])
            meta = {'source_label': '旧草稿', 'legacy_hash': draft['content_hash']}
            metadata = self.store.conn.execute('SELECT series,episode FROM creative_article_metadata WHERE account_id=? AND draft_id=?',
                                               (self.account['id'], ref)).fetchone() if self._has_table('creative_article_metadata') else None
            series = metadata['series'] or None if metadata else None
            episode = metadata['episode'] if metadata else None
            return self.docs.create(title=draft['title'], content=content, origin='legacy_draft', origin_ref=ref,
                                    series=series, episode=episode, meta=meta, producer='legacy')
        return self._open_legacy_job(ref)

    def _open_legacy_job(self, job_id: str) -> dict:
        engine, _cfg, job_store = self.service._job_app(job_id, allow_hidden=False)
        try:
            job = job_store.get_job(job_id)
            article = job_store.get_article(job['article_id'])
            if article['spec'].get('account_id', 'ice-loop') != self.account['id']:
                raise DocumentError('只能接入当前公众号的文章')
            state = engine._load_state(job_id)
            body = state.get('integrated_md') or state.get('draft_md', '')
            if not body.strip():
                raise DocumentError('这个旧任务还没有正文，无法接入文章列表')
            content = md_to_content(body)
            resolved, missing = self._resolve_legacy_slots(job_store, article, content)
            title = article.get('final_title') or article.get('topic') or '旧任务文章'
            meta = {'source_label': '旧制作任务', 'legacy_hash': sha256_text(body), 'job_state': job['state'],
                    'resolved_images': resolved, 'missing_images': missing,
                    'runs': sorted((state.get('runs') or {}).keys())}
        finally:
            job_store.close()
        return self.docs.create(title=title, content=content, origin='legacy_job', origin_ref=job_id,
                                series=article.get('series') or None, episode=article.get('episode'),
                                meta=meta, producer='legacy')

    def _resolve_legacy_slots(self, job_store: Any, article: dict, content: dict) -> tuple[int, int]:
        """旧图位：有有效采纳图则接入为资源引用；缺失则保留占位，不伪造图片。"""
        from ..providers.tapnow import selected_asset
        slots = {s.get('figure_no'): s for s in job_store.article_slots(article['article_id'])}
        resolved = missing = 0

        def walk(nodes: list[dict]) -> None:
            nonlocal resolved, missing
            for index, node in enumerate(nodes):
                if node.get('type') == 'imageSlot':
                    slot = slots.get(node['attrs'].get('figureNo'))
                    candidate = selected_asset(job_store, slot) if slot else None
                    if candidate:
                        resource = self._resource_from_file(Path(candidate['file_path']), node['attrs'].get('caption', ''),
                                                            {'kind': 'legacy_job', 'candidate_id': candidate['candidate_id']})
                        nodes[index] = {'type': 'articleImage', 'attrs': {
                            'id': node['attrs']['id'], 'resourceId': resource['resource_id'],
                            'caption': node['attrs'].get('caption', ''), 'alt': node['attrs'].get('caption', ''),
                            'width': 100, 'align': 'center', 'sourceUrl': ''}}
                        resolved += 1
                    else:
                        missing += 1
                elif node.get('content') and node.get('type') in ('bulletList', 'orderedList', 'listItem', 'blockquote'):
                    walk(node['content'])
        walk(content['doc']['content'])
        return resolved, missing

    def _resource_from_file(self, path: Path, title: str, source: dict) -> dict:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        for resource in self.assets.resources():
            if resource.get('sha256') == digest:
                return resource
        resource = self.assets.import_image(path)
        resource.pop('content_hash', None)
        if title:
            resource['title'] = title[:100]
        resource['document_source'] = source
        self.assets.save_resource(resource)
        return self.assets.resource(resource['resource_id'])

    # ============================================================ editing
    def create(self, params: dict) -> dict:
        kind = params.get('kind', 'blank')
        style = params.get('style')
        if kind == 'blank':
            content = None
            if style:
                from .schema import empty_content
                content = empty_content(style)
            return self.docs.create(title=params.get('title') or '未命名文章', content=content, origin='blank',
                                    series=params.get('series') or None, episode=params.get('episode'))
        if kind == 'markdown':
            text = params.get('markdown', '')
            content = md_to_content(text, style)
            document = self.docs.create(title=params.get('title'), content=content, origin='import',
                                        meta={'source_label': 'Markdown 导入'})
            with self.store.transaction():
                self.docs.bind_import(self.docs.record_import(document_id=None, kind='markdown', original=text,
                                                              report={'mode': 'markdown'}), document['document_id'])
            return document
        raise DocumentError('新建方式无效')

    def get(self, params: dict) -> dict:
        document_id = self._id(params)
        self.reconcile_generations(document_id)
        document = self.docs.get(document_id)
        document['imports'] = self.docs.imports(document_id)
        document['deliveries'] = self.docs.deliveries(document_id)[:20]
        document['legacy_readonly'] = document['origin'] == 'legacy_job'
        return document

    @staticmethod
    def _id(params: dict) -> str:
        value = params.get('document_id')
        if not isinstance(value, str) or not value.startswith('doc-'):
            raise DocumentError('缺少文章标识')
        return value

    def save_working(self, params: dict) -> dict:
        document_id = self._id(params)
        try:
            return self.docs.save_working(document_id, params.get('content'), base_revision=params.get('base_revision'),
                                          title=params.get('title'), force=params.get('force') is True)
        except WorkingConflict as conflict:
            return {'conflict': True, 'message': str(conflict), 'server': conflict.server, 'document_id': document_id}

    def commit_version(self, params: dict) -> dict:
        return self.docs.commit_version(self._id(params), base_revision=params.get('base_revision'),
                                        note=params.get('note', ''))

    def versions(self, params: dict) -> list[dict]:
        return self.docs.versions(self._id(params))

    def version(self, params: dict) -> dict:
        value = self.docs.version(self._id(params), params.get('version_id', ''))
        value['markdown'] = content_to_md(value['content'])
        return value

    def restore(self, params: dict) -> dict:
        return self.docs.restore(self._id(params), params.get('version_id', ''), base_revision=params.get('base_revision'))

    def update_meta(self, params: dict) -> dict:
        return self.docs.update_meta(self._id(params), {k: params[k] for k in ('title', 'series', 'episode') if k in params})

    def trash(self, params: dict) -> dict:
        return self.docs.set_lifecycle(self._id(params), 'trashed')

    def restore_trashed(self, params: dict) -> dict:
        return self.docs.set_lifecycle(self._id(params), 'active')

    def delete_forever(self, params: dict) -> dict:
        """v3.14 永久删除回收站里的文章（不可恢复）。

        参数二选一：document_ids（≤200）或 all_trashed=true（清空回收站）。
        能删的一个事务内删除；已登记发布、仍在生成的文章保留在回收站并说明原因。
        """
        if params.get('all_trashed') is True:
            ids = [row['document_id'] for row in self.store.conn.execute(
                "SELECT document_id FROM documents WHERE account_id=? AND lifecycle='trashed' ORDER BY trashed_at",
                (self.account['id'],))]
        else:
            ids = params.get('document_ids')
            if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
                raise DocumentError('请先选择要永久删除的文章')
            ids = list(dict.fromkeys(ids))
            if len(ids) > 200:
                raise DocumentError('一次最多永久删除 200 篇')
        deleted: list[str] = []
        kept: list[dict] = []
        with self.store.transaction():
            for document_id in ids:
                document = self.docs._row(document_id)  # 不属于当前公众号：整批拒绝
                reason = self.docs.delete_blocker(document)
                if reason:
                    kept.append({'document_id': document_id, 'title': document['title'], 'reason': reason})
                    continue
                self.docs.delete_forever(document_id)
                deleted.append(document_id)
        return {'deleted': deleted, 'kept': kept}

    def duplicate(self, params: dict) -> dict:
        """复制为新文章：旧代码任务等不可继续执行的来源，以独立新稿继续写。"""
        source = self.docs.get(self._id(params))
        if params.get('version_id'):
            content = self.docs.version(source['document_id'], params['version_id'])['content']
        else:
            content = source['content']
        title = (params.get('title') or source['title'] + '（副本）')[:300]
        return self.docs.create(title=title, content=content, origin='copy', origin_ref='',
                                series=source['series'], episode=None,
                                meta={'source_label': '副本', 'copied_from': source['document_id']})

    def markdown(self, params: dict) -> dict:
        """只读 Markdown 投影（源码查看/AI 上下文）。"""
        document = self.docs.get(self._id(params))
        return {'markdown': content_to_md(document['content']), 'content_hash': document['content_hash'],
                'lossy': ['局部字号/颜色', '对齐', '图片宽度', '未支持模块的交付方式']}

    # ============================================================ paste
    def convert_paste(self, params: dict) -> dict:
        """粘贴转换：返回可插入的文档片段与导入报告；原件留档以便改为“仅保留文字”。"""
        mode = params.get('mode', 'adapt')
        html = params.get('html')
        text = params.get('text')
        style = normalize_style(params.get('style') or {})
        if isinstance(html, str) and html.strip():
            content, report = convert_html(html, mode=mode, style=style, import_image=self._import_pasted_image)
            kind, original = 'html', html
        elif isinstance(text, str) and text.strip():
            content, report = convert_text(text, style=style)
            kind, original = 'text', text
        else:
            raise DocumentError('剪贴板里没有可导入的文字或网页内容')
        with self.store.transaction():
            import_id = self.docs.record_import(document_id=params.get('document_id') if isinstance(params.get('document_id'), str) else None,
                                                kind=kind, original=original, report=report)
        return {'import_id': import_id, 'content': content, 'report': report}

    def import_paste(self, params: dict) -> dict:
        """粘贴新建文章。"""
        converted = self.convert_paste({**params, 'document_id': None})
        content = converted['content']
        document = self.docs.create(title=params.get('title'), content=content, origin='paste',
                                    meta={'source_label': '粘贴导入', 'import_id': converted['import_id'],
                                          'paste_mode': converted['report']['mode']},
                                    note='粘贴导入（' + ('适配当前样式' if converted['report']['mode'] == 'adapt' else '仅保留文字') + '）')
        with self.store.transaction():
            self.docs.bind_import(converted['import_id'], document['document_id'])
        return {**document, 'report': converted['report'], 'import_id': converted['import_id']}

    def import_docx(self, params: dict) -> dict:
        """P1 Word（.docx）文件导入：本地转换为受限 HTML 后复用粘贴管线；原文件另存一份，转换中间件作为可重转原件。"""
        from .docx_import import docx_to_html
        name = str(params.get('file_name') or 'Word 文档')[:200]
        if not name.lower().endswith('.docx'):
            raise DocumentError('只支持 .docx 文件；旧版 .doc 请先在 Word 中另存为 .docx')
        raw = params.get('data_base64')
        if not isinstance(raw, str) or not raw or len(raw) > 28_000_000:
            raise DocumentError('Word 文件需小于 20MB')
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise DocumentError('Word 文件数据无效') from None
        mode = params.get('mode', 'adapt')
        html, docx_report = docx_to_html(data)
        digest = hashlib.sha256(data).hexdigest()

        def import_image(src: str, alt: str) -> dict | None:
            match = _DATA_URL.match(src or '')
            if not match:
                return None
            try:
                return self.import_image_bytes(base64.b64decode(match.group(2), validate=False), alt or '文档图片',
                                               {'kind': 'docx', 'original_name': name})
            except (DocumentError, ValueError, binascii.Error, OSError):
                return None
        try:
            content, report = convert_html(html, mode=mode, style=normalize_style(params.get('style') or {}), import_image=import_image)
        except ValueError as error:
            raise DocumentError(str(error)) from None
        report['docx'] = {**docx_report, 'file_name': name, 'sha256': digest, 'bytes': len(data)}
        folder = self.service.runtime / 'imports' / self.account['id']
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (digest + '.docx')).write_bytes(data)
        stem = re.sub(r'\.docx$', '', name, flags=re.I).strip()
        title = params.get('title') or None
        document = self.docs.create(title=title or (None if any(b['type'] == 'heading' for b in content['doc']['content'][:1]) else stem[:300]),
                                    content=content, origin='import',
                                    meta={'source_label': 'Word 导入', 'file_name': name, 'docx_sha256': digest},
                                    note='Word 导入（' + ('适配当前样式' if mode == 'adapt' else '仅保留文字') + '）')
        with self.store.transaction():
            import_id = self.docs.record_import(document_id=None, kind='html', original=html, report=report)
            self.docs.bind_import(import_id, document['document_id'])
        return {**self.get({'document_id': document['document_id']}), 'report': report, 'import_id': import_id}

    def import_original(self, params: dict) -> dict:
        document_id = self._id(params)
        self.docs.get(document_id)
        original = self.docs.import_original(params.get('import_id', ''))
        if original['document_id'] != document_id:
            raise DocumentError('导入原件不属于这篇文章')
        return original

    def reconvert(self, params: dict) -> dict:
        """把整篇粘贴稿按原件重新转换（适配 ⇄ 仅文字）。先固化当前版本，因此可从版本历史撤回。"""
        document_id = self._id(params)
        original = self.docs.import_original(params.get('import_id', ''))
        if original['document_id'] != document_id:
            raise DocumentError('导入原件不属于这篇文章')
        mode = params.get('mode')
        document = self.docs.get(document_id)
        if original['kind'] == 'html':
            content, report = convert_html(original['original'], mode=mode, style=document['content']['style'],
                                           import_image=self._import_pasted_image)
        else:
            content, report = convert_text(original['original'], style=document['content']['style'])
        with self.store.transaction():
            if document['unversioned_changes']:
                self.docs.commit_version(document_id, base_revision=document['revision'], note='转换前自动保存', producer='autosave')
            saved = self.docs.save_working(document_id, content, base_revision=params.get('base_revision'))
            version = self.docs.commit_version(document_id, base_revision=saved['revision'],
                                               note='改为' + ('适配当前样式' if mode == 'adapt' else '仅保留文字'),
                                               producer='convert')
        return {**self.docs.get(document_id), 'report': report, 'version_id': version['version_id']}

    def _import_pasted_image(self, src: str, alt: str) -> dict | None:
        match = _DATA_URL.match(src or '')
        if not match:
            return None
        try:
            return self.import_image_bytes(base64.b64decode(match.group(2), validate=False), alt or '粘贴图片',
                                           {'kind': 'paste_html'})
        except (DocumentError, ValueError, binascii.Error, OSError):
            return None

    # ============================================================ images
    def import_image_bytes(self, data: bytes, title: str, source: dict | None = None) -> dict:
        if not data or len(data) > 32 * 1024 * 1024:
            raise DocumentError('图片需小于 32MB')
        from PIL import Image, UnidentifiedImageError
        from ..image_memory import IMAGE_DECODE_GATE
        try:
            with IMAGE_DECODE_GATE:
                with Image.open(io.BytesIO(data)) as image:
                    fmt = image.format
                    if image.width * image.height > 40_000_000:
                        raise DocumentError('图片像素过大')
                    converted = None
                    if fmt not in ('PNG', 'JPEG', 'WEBP'):
                        # GIF/BMP/TIFF 等：取首帧转 PNG，原格式记入资源说明。
                        buffer = io.BytesIO()
                        image.convert('RGBA').save(buffer, 'PNG')
                        converted, data = fmt, buffer.getvalue()
        except UnidentifiedImageError:
            raise DocumentError('无法识别的图片格式') from None
        staging = self.service.runtime / 'staging' / 'document-images'
        staging.mkdir(parents=True, exist_ok=True)
        temp = staging / (uuid4().hex + ('.png' if converted or fmt == 'PNG' else '.jpg' if fmt == 'JPEG' else '.webp'))
        temp.write_bytes(data)
        try:
            info = {'kind': 'paste', **(source or {}), 'converted_from': converted or '', 'original_format': fmt or '',
                    'original_bytes': len(data), 'imported_at': now_iso()}
            resource = self._resource_from_file(temp, title, info)
        finally:
            temp.unlink(missing_ok=True)
        return resource

    def image_import(self, params: dict) -> dict:
        """桌面主进程经系统对话框选择文件后调用（渲染层不提供路径）。"""
        path = Path(str(params.get('file_path', '')))
        if not path.is_file():
            raise DocumentError('图片文件不存在')
        resource = self.import_image_bytes(path.read_bytes(), path.stem, {'kind': 'file', 'original_name': path.name[:200]})
        return self._image_view(resource)

    def image_import_data(self, params: dict) -> dict:
        match = _DATA_URL.match(str(params.get('data_url', ''))[:45_000_000])
        if not match:
            raise DocumentError('剪贴板图片格式无效')
        try:
            data = base64.b64decode(match.group(2), validate=False)
        except binascii.Error:
            raise DocumentError('剪贴板图片数据无效') from None
        name = str(params.get('name') or '粘贴图片')[:100]
        return self._image_view(self.import_image_bytes(data, name, {'kind': 'clipboard', 'original_name': name}))

    def image_view(self, params: dict) -> dict:
        resource = self.assets.resource(params.get('resource_id', ''))
        return self._image_view(resource)

    def _image_view(self, resource: dict) -> dict:
        try:
            preview = self.assets.preview(resource['resource_id'])['data_url']
            ok = True
        except (ValueError, OSError):
            preview, ok = '', False
        return {'resource_id': resource['resource_id'], 'title': resource.get('title', ''), 'width': resource.get('width'),
                'height': resource.get('height'), 'mime': resource.get('mime'), 'size': resource.get('size'),
                'preview': preview, 'ok': ok, 'source': self._source_view(resource)}

    # ------------------------------------------- P1 图片来源、裁切与压缩
    _SOURCE_LABEL = {'paste': '粘贴', 'paste_html': '从网页/文档粘贴', 'docx': 'Word 文件', 'svg': 'SVG 转图', 'clipboard': '剪贴板截图', 'file': '本地文件',
                     'edit': '裁切/压缩生成', 'library': '素材库'}

    def _source_view(self, resource: dict) -> dict:
        source = dict(resource.get('document_source') or {})
        kind = source.get('kind') or ('library' if not source else 'paste')
        return {'kind': kind, 'label': self._SOURCE_LABEL.get(kind, '其他'), 'original_name': source.get('original_name', ''),
                'source_url': source.get('source_url', ''), 'rights_note': source.get('rights_note', ''),
                'derived_from': source.get('derived_from', ''), 'operation': source.get('operation'),
                'imported_at': source.get('imported_at', ''), 'original_bytes': source.get('original_bytes'),
                'converted_from': source.get('converted_from', '')}

    def image_source_update(self, params: dict) -> dict:
        """用户补充图片来源与权利说明（来源记录不等于使用许可）。"""
        resource = self.assets.resource(params.get('resource_id', ''))
        url = params.get('source_url', '')
        if not isinstance(url, str) or len(url) > 2000:
            raise DocumentError('来源链接过长')
        url = url.strip()
        if url and urlsplit(url).scheme not in ('http', 'https'):
            raise DocumentError('来源链接只支持 http/https')
        note = params.get('rights_note', '')
        if not isinstance(note, str) or len(note) > 200:
            raise DocumentError('权利说明最多 200 字')
        source = dict(resource.get('document_source') or {})
        source.update(source_url=url, rights_note=note.strip())
        resource['document_source'] = source
        self.assets.save_resource(resource)
        return self._image_view(self.assets.resource(resource['resource_id']))

    def image_edit(self, params: dict) -> dict:
        """裁切/缩放/压缩：生成一张新图片资源，原图保持不变（可在素材库找回）。"""
        from PIL import Image, ImageOps
        from ..image_memory import IMAGE_DECODE_GATE
        resource = self.assets.resource(params.get('resource_id', ''))
        path = self.assets.checked_path(resource)
        crop = params.get('crop')
        if crop is not None:
            if not isinstance(crop, dict) or any(not isinstance(crop.get(k), (int, float)) or isinstance(crop.get(k), bool)
                                                 for k in ('x', 'y', 'w', 'h')):
                raise DocumentError('裁切区域无效')
            x, y, w, h = (float(crop[k]) for k in ('x', 'y', 'w', 'h'))
            if not (0 <= x < 1 and 0 <= y < 1 and 0.02 <= w <= 1 and 0.02 <= h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
                raise DocumentError('裁切区域超出图片范围')
        max_width = params.get('max_width')
        if max_width is not None and (type(max_width) is not int or not 200 <= max_width <= 4096):
            raise DocumentError('最大宽度需在 200–4096 像素之间')
        fmt = params.get('format', 'keep')
        if fmt not in ('keep', 'jpeg', 'png'):
            raise DocumentError('输出格式只支持保持原格式、JPEG 或 PNG')
        quality = params.get('quality', 85)
        if type(quality) is not int or not 50 <= quality <= 95:
            raise DocumentError('压缩质量需在 50–95 之间')
        if crop is None and max_width is None and fmt == 'keep' and resource.get('mime') not in ('image/jpeg', 'image/webp'):
            raise DocumentError('没有需要处理的设置')
        with IMAGE_DECODE_GATE:
            with Image.open(path) as opened:
                image = ImageOps.exif_transpose(opened)
                image.load()
        if crop is not None:
            box = (round(x * image.width), round(y * image.height),
                   min(image.width, round((x + w) * image.width)), min(image.height, round((y + h) * image.height)))
            if box[2] - box[0] < 8 or box[3] - box[1] < 8:
                raise DocumentError('裁切后的图片太小')
            image = image.crop(box)
        if max_width is not None and image.width > max_width:
            image = image.resize((max_width, max(1, round(image.height * max_width / image.width))), Image.LANCZOS)
        source_mime = resource.get('mime', '')
        out = 'jpeg' if fmt == 'jpeg' or (fmt == 'keep' and source_mime == 'image/jpeg') else 'png' \
            if fmt == 'png' or source_mime == 'image/png' else 'webp'
        buffer = io.BytesIO()
        if out == 'jpeg':
            if image.mode in ('RGBA', 'LA', 'P'):
                background = Image.new('RGB', image.size, (255, 255, 255))
                rgba = image.convert('RGBA')
                background.paste(rgba, mask=rgba.split()[-1])
                image = background
            image.convert('RGB').save(buffer, 'JPEG', quality=quality, optimize=True, progressive=True)
        elif out == 'png':
            image.save(buffer, 'PNG', optimize=True)
        else:
            image.save(buffer, 'WEBP', quality=quality)
        data = buffer.getvalue()
        operation = {'crop': crop, 'max_width': max_width, 'format': out, 'quality': quality if out != 'png' else None,
                     'width': image.width, 'height': image.height}
        original = dict(resource.get('document_source') or {})
        edited = self.import_image_bytes(data, (resource.get('title') or '图片')[:90] + '（处理后）', {
            'kind': 'edit', 'derived_from': resource['resource_id'], 'operation': operation,
            'source_url': original.get('source_url', ''), 'rights_note': original.get('rights_note', ''),
            'original_name': original.get('original_name', '')})
        view = self._image_view(edited)
        view['before'] = {'size': resource.get('size'), 'width': resource.get('width'), 'height': resource.get('height')}
        return view

    def images_library(self, params: dict) -> list[dict]:
        rows = self.assets.resources()[:200]
        return [{'resource_id': r['resource_id'], 'title': r.get('title', ''), 'width': r.get('width'),
                 'height': r.get('height'), 'mime': r.get('mime'), 'size': r.get('size')} for r in rows]

    # ============================================================ delivery
    def _resolver(self, variant: str):
        def resolve(attrs: dict) -> dict | None:
            try:
                resource = self.assets.resource(attrs.get('resourceId', ''))
                path = self.assets.checked_path(resource)
            except (ValueError, OSError):
                return None
            mime = resource['mime']

            def data_url(preview: bool) -> str:
                if variant == 'clipboard' and resource['size'] <= 2 * 1024 * 1024 and resource['width'] <= 1920:
                    return image_data_url(path, mime, preview=False)
                return image_data_url(path, mime, preview=True, cache_dir=self.service.runtime / 'cache' / 'delivery-previews',
                                      sha256=resource.get('sha256', ''))
            return {'file_path': str(path), 'mime': mime, 'size': resource['size'], 'width': resource['width'],
                    'height': resource['height'], 'sha256': resource['sha256'], 'data_url': data_url}
        return resolve

    def _frozen_version(self, params: dict) -> dict:
        document_id = self._id(params)
        version_id = params.get('version_id')
        if not version_id:
            document = self.docs.get(document_id)
            if document['generation_state'] == 'running':
                raise DocumentError('AI 初稿仍在生成，完成后再交付')
            if document['unversioned_changes']:
                version_id = self.docs.commit_version(document_id, base_revision=params.get('base_revision'),
                                                      note='交付前自动保存', producer='delivery')['version_id']
            else:
                if params.get('base_revision') is not None and params['base_revision'] != document['revision']:
                    raise DocumentError('工作副本已更新，请等待保存完成后再交付')
                version_id = document['head_version_id']
        return self.docs.version(document_id, version_id)

    def render_delivery(self, params: dict, *, variant: str = 'preview') -> dict:
        version = self._frozen_version(params)
        image_mode = params.get('image_mode', 'embed')
        if image_mode not in ('embed', 'placeholder'):
            raise DocumentError('图片输出方式无效')
        result = Renderer(version['content'], resolve_image=self._resolver(variant), image_mode=image_mode,
                          for_preview=variant == 'preview').run()
        digest = delivery_hash(version, result['images'])
        images = [{k: v for k, v in image.items() if k != 'file_path'} for image in result['images']]
        for image in images:
            if not image.get('missing'):
                image['file_name'] = f"{image['order']:02d}-{_file_name(image['caption'] or 'image')}" + \
                    {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}.get(image['mime'], '')
        if variant == 'clipboard':
            large = [i for i in result['images'] if not i.get('missing') and (i['size'] > 2 * 1024 * 1024 or i['width'] > 1920)]
            if large:
                result['issues'].append({'severity': 'info', 'kind': 'clipboard_downscaled', 'block_id': '',
                                         'message': f'{len(large)} 张大图在剪贴板中使用了缩小副本；原图在导出图片包中'})
        info, cover = self._article_info(version, images, result['issues'])
        blocking = [i for i in result['issues'] if i['severity'] == 'error']
        return {'document_id': version['document_id'], 'version_id': version['version_id'],
                'version_created_at': version['created_at'], 'title': version['title'],
                'content_hash': version['content_hash'], 'delivery_hash': digest,
                'html': result['html'], 'text': result['text'], 'images': images, 'issues': result['issues'],
                'complete': not blocking, 'style': version['content']['style'], 'info': info, 'cover': cover}

    def _article_info(self, version: dict, images: list[dict], issues: list[dict]) -> tuple[dict, dict | None]:
        """v3.2 文章设置：标题/作者长度按公众号上限提示；封面优先用指定图，否则取正文第一张图。"""
        from .schema import AUTHOR_LIMIT, TITLE_LIMIT
        info = dict(version['content'].get('info') or {})
        if len(version['title']) > TITLE_LIMIT:
            issues.append({'severity': 'warning', 'kind': 'title_too_long', 'block_id': '',
                           'message': f'标题 {len(version["title"])} 字，超过公众号 {TITLE_LIMIT} 字上限，粘贴到后台前请缩短'})
        if len(info.get('author', '')) > AUTHOR_LIMIT:
            issues.append({'severity': 'warning', 'kind': 'author_too_long', 'block_id': '',
                           'message': f'作者超过公众号 {AUTHOR_LIMIT} 字上限'})
        cover = None
        if info.get('coverResourceId'):
            try:
                resource = self.assets.resource(info['coverResourceId'])
                self.assets.checked_path(resource)
                cover = {'resource_id': resource['resource_id'], 'source': 'explicit', 'mime': resource['mime'],
                         'width': resource['width'], 'height': resource['height'], 'sha256': resource['sha256']}
            except (ValueError, OSError):
                issues.append({'severity': 'warning', 'kind': 'cover_missing', 'block_id': '',
                               'message': '指定的封面图片已缺失，请在“文章设置”中重新选择'})
        if cover is None:
            first = next((i for i in images if not i.get('missing')), None)
            if first:
                cover = {'resource_id': first['resource_id'], 'source': 'first_image', 'mime': first['mime'],
                         'width': first['width'], 'height': first['height'], 'sha256': first['sha256']}
            elif not info.get('coverResourceId'):
                issues.append({'severity': 'info', 'kind': 'cover_none', 'block_id': '',
                               'message': '没有封面：正文没有图片，也没有在“文章设置”中指定，发布前需在后台选择封面'})
        if cover:
            cover['file_name'] = '封面' + {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}.get(cover['mime'], '')
        return info, cover

    def copy_payload(self, params: dict) -> dict:
        """仅供桌面主进程写系统剪贴板（渲染层不能注入任意 HTML）。"""
        return self.render_delivery(params, variant='clipboard')

    def delivery_record(self, params: dict) -> dict:
        kind = params.get('kind')
        if kind not in ('copy_html', 'copy_text'):
            raise DocumentError('交付记录类型无效')
        document_id = self._id(params)
        version = self.docs.version(document_id, params.get('version_id', ''), content=False)
        delivery_id = self.docs.record_delivery(document_id=document_id, version_id=version['version_id'],
                                                delivery_hash=str(params.get('delivery_hash', ''))[:80], kind=kind,
                                                issues=params.get('issues') if isinstance(params.get('issues'), list) else [])
        return {'delivery_id': delivery_id, 'version_id': version['version_id']}

    # ------------------------------------------------ P2 长图与切片、SVG 转图
    def long_image_page(self, params: dict) -> dict:
        """主进程专用：返回冻结版本的长图页面（无脚本、仅 data: 图片）。"""
        from .longimage import page_html
        width = params.get('width', 375)
        rendered = self.render_delivery({k: v for k, v in params.items() if k != 'width'}, variant='preview')
        version = self.docs.version(rendered['document_id'], rendered['version_id'], content=False)
        return {'html': page_html(rendered['html'], version['title'], (rendered.get('info') or {}).get('author', ''), width),
                'version_id': rendered['version_id'], 'issues': rendered['issues']}

    def long_image_compose(self, params: dict) -> dict:
        """主进程专用：拼接分段截图，按空白行切片，写入经目录选择器授权的新目录。"""
        from ..export.bundle import _assert_no_links
        from ..paths import assert_not_c_drive
        from .longimage import WIDTHS, stitch, write_bundle
        destination = params.get('destination')
        if not isinstance(destination, str) or not destination.strip() or not Path(destination).is_absolute():
            raise DocumentError('请先通过目录选择器选择导出位置')
        destination = Path(destination)
        assert_not_c_drive(destination)
        _assert_no_links(destination)
        destination = destination.resolve()
        document_id = self._id(params)
        version = self.docs.version(document_id, str(params.get('version_id', '')), content=False)
        width = params.get('width')
        if width not in WIDTHS:
            raise DocumentError('长图宽度只支持 375/414/750')
        canvas, scale = stitch(params.get('segments'), params.get('total_height'), width)
        return write_bundle(destination, canvas, scale, params.get('slice_height', 1200), {
            'kind': 'long_image', 'document_id': document_id, 'version_id': version['version_id'], 'title': version['title'],
            'css_width': width, 'created_at': now_iso()})

    def svg_import(self, params: dict) -> dict:
        """主进程专用：SVG 已在隐藏窗口里以 <img> 渲染为 PNG；这里入库位图并留存 SVG 原件。"""
        from .longimage import check_svg
        svg = check_svg(params.get('svg'))
        name = str(params.get('name') or 'SVG 图').strip()[:100] or 'SVG 图'
        try:
            data = base64.b64decode(str(params.get('png_base64', '')), validate=True)
        except (binascii.Error, ValueError):
            raise DocumentError('SVG 渲染结果无效') from None
        digest = hashlib.sha256(svg.encode('utf-8')).hexdigest()
        folder = self.service.runtime / 'imports' / self.account['id']
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (digest + '.svg')).write_text(svg, encoding='utf-8')
        resource = self.import_image_bytes(data, name, {'kind': 'svg', 'original_name': name[:200], 'svg_sha256': digest})
        return self._image_view(resource)

    # ------------------------------------------------ v3.12 微信兼容测试稿与记录
    def perf_sample(self, params: dict) -> dict:
        """v3.12 在当前公众号生成长文多图性能固定样本（默认约 1 万字 / 30 张测试图）。"""
        from . import perfsample
        result = perfsample.build(self, chars=params.get('chars', perfsample.DEFAULT_CHARS),
                                  images=params.get('images', perfsample.DEFAULT_IMAGES), seed=params.get('seed', 1))
        return {k: result[k] for k in ('document_id', 'chars', 'images', 'seed', 'image_bytes')}

    def compat_create(self, params: dict) -> dict:
        from .compat import CompatTesting
        return CompatTesting(self).create(params)

    def compat_get(self, params: dict) -> dict:
        from .compat import CompatTesting
        return CompatTesting(self).get(params)

    def compat_record(self, params: dict) -> dict:
        from .compat import CompatTesting
        return CompatTesting(self).record(params)

    def compat_report(self, params: dict) -> dict:
        from .compat import CompatTesting
        return CompatTesting(self).report(params)

    def export_bundle(self, params: dict) -> dict:
        from ..export.bundle import _assert_no_links, _cleanup_owned_staging, _file_sha256, _tree_hashes
        from ..paths import assert_not_c_drive
        destination = params.get('destination')
        if not isinstance(destination, str) or not destination.strip():
            raise DocumentError('请先通过目录选择器选择导出位置')
        destination = Path(destination)
        if not destination.is_absolute():
            raise DocumentError('导出目录必须使用绝对路径（请通过界面目录选择器获取）')
        assert_not_c_drive(destination)
        _assert_no_links(destination)
        destination = destination.resolve()
        if destination.exists():
            raise DocumentError('导出目录已存在；为避免覆盖请使用新的导出目录')
        rendered = self.render_delivery(params, variant='bundle')
        version = self.docs.version(rendered['document_id'], rendered['version_id'])
        resolver = self._resolver('bundle')
        token = uuid4().hex
        staging = destination.parent / (destination.name + '-staging-' + token)
        identity = None
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            _assert_no_links(destination.parent)
            staging.mkdir()
            stat = staging.stat()
            identity = (stat.st_dev, stat.st_ino)
            (staging / '.ice-export-owner').write_text(token, encoding='ascii')
            image_dir = staging / '图片'
            image_dir.mkdir()
            manifest_images = []
            names = {}
            for image in rendered['images']:
                if image.get('missing'):
                    manifest_images.append({'order': image['order'], 'caption': image['caption'], 'missing': True})
                    continue
                source = resolver({'resourceId': image['resource_id']})
                if not source or source['sha256'] != image['sha256']:
                    raise DocumentError(f"图{image['order']}在导出期间发生变化，请重新导出")
                target = image_dir / image['file_name']
                shutil.copyfile(source['file_path'], target)  # 原图字节，不重压缩
                if _file_sha256(target) != image['sha256']:
                    raise DocumentError(f"图{image['order']}复制后校验失败")
                names[image['block_id']] = image['file_name']
                manifest_images.append({'order': image['order'], 'file': '图片/' + image['file_name'],
                                        'caption': image['caption'], 'mime': image['mime'], 'size': image['size'],
                                        'width': image['width'], 'height': image['height'], 'sha256': image['sha256'],
                                        'source_url': image.get('source_url', ''), 'block_id': image['block_id']})
            cover = rendered.get('cover')
            if cover:
                source = resolver({'resourceId': cover['resource_id']})
                if not source or source['sha256'] != cover['sha256']:
                    raise DocumentError('封面图片在导出期间发生变化，请重新导出')
                shutil.copyfile(source['file_path'], staging / cover['file_name'])
            # 预览 HTML 使用相对图片路径；与复制用 HTML 来自同一渲染器与同一版本。
            local = Renderer(version['content'], resolve_image=lambda attrs: (
                {**src, 'data_url': (lambda _p, n=names.get(attrs.get('id')): '图片/' + n)}
                if (src := resolver(attrs)) and names.get(attrs.get('id')) else None)).run()
            page = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    f'<title>{htmllib.escape(rendered["title"])}</title></head><body style="margin:0;background:#f5f6f8;">'
                    '<main style="max-width:677px;margin:24px auto;padding:24px 20px;background:#fff;">'
                    + local['html'] + '</main></body></html>')
            (staging / '正文预览.html').write_text(page, encoding='utf-8', newline='\n')
            (staging / '正文.txt').write_text(rendered['text'], encoding='utf-8', newline='\n')
            (staging / '正文.md').write_text(content_to_md(version['content']), encoding='utf-8', newline='\n')
            manifest = {'format': 'ice-document-export-v1', 'document_id': rendered['document_id'],
                        'version_id': rendered['version_id'], 'content_hash': rendered['content_hash'],
                        'delivery_hash': rendered['delivery_hash'], 'title': rendered['title'],
                        'exported_at': now_iso(), 'complete': rendered['complete'], 'issues': rendered['issues'],
                        'images': manifest_images, 'files': _tree_hashes(staging),
                        'article': {'author': rendered['info'].get('author', ''), 'summary': rendered['info'].get('summary', ''),
                                    'comments': rendered['info'].get('comments', 'off'),
                                    'source_url': rendered['info'].get('sourceUrl', ''),
                                    'cover': ({'file': cover['file_name'], 'source': cover['source']} if cover else None)},
                        'note': '导出不等于已发布；发布后请在应用中登记发布链接与时间。'}
            (staging / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
                                                   encoding='utf-8', newline='\n')
            _assert_no_links(staging)
            if destination.exists():
                raise DocumentError('导出目录在提交前已存在，请选择新目录')
            staging.rename(destination)
            (destination / '.ice-export-owner').unlink()
        finally:
            if identity is not None:
                _cleanup_owned_staging(staging, destination.parent, token, identity)
        delivery_id = self.docs.record_delivery(document_id=rendered['document_id'], version_id=rendered['version_id'],
                                                delivery_hash=rendered['delivery_hash'], kind='export',
                                                destination=str(destination), issues=rendered['issues'])
        return {'destination': str(destination), 'delivery_id': delivery_id, 'version_id': rendered['version_id'],
                'images': sum(1 for i in manifest_images if not i.get('missing')),
                'missing_images': sum(1 for i in manifest_images if i.get('missing')),
                'complete': rendered['complete'], 'issues': rendered['issues']}

    # ============================================================ publications
    def register_publication(self, params: dict) -> dict:
        return self.docs.register_publication(self._id(params), params)

    def publications(self, params: dict) -> list[dict]:
        if params.get('document_id'):
            return self.docs.publications(self._id(params))
        rows = self.store.conn.execute('SELECT p.*, d.title FROM publication_records p JOIN documents d ON d.document_id=p.document_id'
                                       ' WHERE p.account_id=? ORDER BY p.published_at DESC LIMIT 200', (self.account['id'],)).fetchall()
        return [dict(r) for r in rows]

    def withdraw_publication(self, params: dict) -> dict:
        return self.docs.withdraw_publication(str(params.get('record_id', '')))

    # ============================================================ bookmarks
    def bookmarks(self, params: dict) -> list[dict]:
        aid = self.account['id']
        with self.store.transaction():
            if not self.store.conn.execute('SELECT 1 FROM bookmark_seeds WHERE account_id=?', (aid,)).fetchone():
                now = now_iso()
                for position, (url, title) in enumerate(DEFAULT_BOOKMARKS):
                    self.store.conn.execute('INSERT OR IGNORE INTO bookmarks VALUES (?,?,?,?,?,?,?,?)',
                                            (new_id('bm'), aid, url, title, position, 1, now, now))
                self.store.conn.execute('INSERT INTO bookmark_seeds VALUES (?,?)', (aid, now))
        rows = self.store.conn.execute('SELECT * FROM bookmarks WHERE account_id=? ORDER BY position, created_at', (aid,)).fetchall()
        return [{**dict(r), 'is_default': bool(r['is_default'])} for r in rows]

    def bookmark_save(self, params: dict) -> dict:
        url = _safe_https(params.get('url'))
        title = params.get('title') or urlsplit(url).hostname
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 80:
            raise DocumentError('收藏名称需为 1–80 字')
        aid = self.account['id']
        now = now_iso()
        bookmark_id = params.get('bookmark_id')
        with self.store.transaction():
            if bookmark_id:
                row = self.store.conn.execute('SELECT * FROM bookmarks WHERE bookmark_id=? AND account_id=?', (bookmark_id, aid)).fetchone()
                if not row:
                    raise DocumentError('收藏不存在或属于其他公众号')
                clash = self.store.conn.execute('SELECT 1 FROM bookmarks WHERE account_id=? AND url=? AND bookmark_id<>?',
                                                (aid, url, bookmark_id)).fetchone()
                if clash:
                    raise DocumentError('这个网址已经收藏过')
                self.store.conn.execute('UPDATE bookmarks SET url=?, title=?, updated_at=? WHERE bookmark_id=?',
                                        (url, title.strip(), now, bookmark_id))
            else:
                existing = self.store.conn.execute('SELECT bookmark_id FROM bookmarks WHERE account_id=? AND url=?', (aid, url)).fetchone()
                if existing:
                    bookmark_id = existing['bookmark_id']
                    self.store.conn.execute('UPDATE bookmarks SET title=?, updated_at=? WHERE bookmark_id=?', (title.strip(), now, bookmark_id))
                else:
                    position = self.store.conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM bookmarks WHERE account_id=?', (aid,)).fetchone()[0]
                    bookmark_id = new_id('bm')
                    self.store.conn.execute('INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?,?)',
                                            (bookmark_id, aid, url, title.strip(), position, 0, now, now))
        return dict(self.store.conn.execute('SELECT * FROM bookmarks WHERE bookmark_id=?', (bookmark_id,)).fetchone())

    def bookmark_remove(self, params: dict) -> dict:
        with self.store.transaction():
            cursor = self.store.conn.execute('DELETE FROM bookmarks WHERE bookmark_id=? AND account_id=?',
                                             (params.get('bookmark_id'), self.account['id']))
        if not cursor.rowcount:
            raise DocumentError('收藏不存在或属于其他公众号')
        return {'removed': True}

    def bookmark_reorder(self, params: dict) -> list[dict]:
        ids = params.get('bookmark_ids')
        current = {b['bookmark_id'] for b in self.bookmarks({})}
        if not isinstance(ids, list) or set(ids) != current or len(ids) != len(current):
            raise DocumentError('收藏顺序与当前列表不一致，请刷新后重试')
        with self.store.transaction():
            for position, bookmark_id in enumerate(ids):
                self.store.conn.execute('UPDATE bookmarks SET position=? WHERE bookmark_id=?', (position, bookmark_id))
        return self.bookmarks({})

    def bookmark_restore_defaults(self, params: dict) -> list[dict]:
        aid = self.account['id']
        now = now_iso()
        with self.store.transaction():
            for url, title in DEFAULT_BOOKMARKS:
                if not self.store.conn.execute('SELECT 1 FROM bookmarks WHERE account_id=? AND url=?', (aid, url)).fetchone():
                    position = self.store.conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM bookmarks WHERE account_id=?', (aid,)).fetchone()[0]
                    self.store.conn.execute('INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?,?)',
                                            (new_id('bm'), aid, url, title, position, 1, now, now))
        return self.bookmarks({})

    # ============================================================ AI drafts (C-04)
    def from_candidate(self, params: dict) -> dict:
        from ..creative_chat import CreativeChat
        candidate = CreativeChat.candidate(self.store, self.account['id'], str(params.get('candidate_id', '')))
        content = md_to_content(candidate['body'])
        meta = {'source_label': 'AI 初稿', 'conversation_id': candidate['conversation_id'], 'candidate_id': candidate['id']}
        meta.update(self._candidate_skills(candidate))
        return self.docs.create(title=candidate['title'], content=content, origin='ai', origin_ref=candidate['id'],
                                series=(candidate['base'] or {}).get('series') or None, meta=meta, producer='ai')

    def _candidate_skills(self, candidate: dict) -> dict:
        """v3.17：从会话存为文章时，带上会话技能（作为本篇技能）和生成这版时实际使用的技能。"""
        from ..skills import normalize_binding, skill_summary
        out: dict = {}
        if self._has_table('conversation_skill_bindings'):
            row = self.store.conn.execute('SELECT binding_json FROM conversation_skill_bindings WHERE account_id=? AND conversation_id=?',
                                          (self.account['id'], candidate['conversation_id'])).fetchone()
            try:
                binding = normalize_binding(json.loads(row['binding_json'])) if row else None
            except (TypeError, ValueError):
                binding = None
            if binding:
                out['skill_binding'] = binding
        row = self.store.conn.execute(
            "SELECT metadata_json FROM creative_messages WHERE conversation_id=? AND json_extract(metadata_json,'$.candidate_id')=? "
            "ORDER BY created_at DESC LIMIT 1", (candidate['conversation_id'], candidate['id'])).fetchone()
        try:
            snapshot = json.loads(row['metadata_json'])['request_snapshot']['writing_profile']['writing_skill_snapshot'] if row else None
        except (TypeError, KeyError, ValueError):
            snapshot = None
        if snapshot:
            out['generated_skills'] = skill_summary(snapshot)
        return out

    def reconcile_generations(self, document_id: str | None = None) -> None:
        """惰性对账：把生成中的 AI 初稿与其会话消息状态对齐（重启后仍成立）。"""
        if not self._has_table('creative_messages'):
            return
        sql = "SELECT document_id, meta_json FROM documents WHERE account_id=? AND generation_state='running'"
        args: tuple = (self.account['id'],)
        if document_id:
            sql += ' AND document_id=?'
            args += (document_id,)
        for row in self.store.conn.execute(sql, args).fetchall():
            meta = json.loads(row['meta_json'] or '{}')
            message = self.store.conn.execute('SELECT status, metadata_json FROM creative_messages WHERE id=?',
                                              (meta.get('message_id', ''),)).fetchone()
            if not message:
                if meta.get('started_at') and not meta.get('message_id'):
                    # chat.send 受理期间，列表轮询可能先于 bind 到达；给启动留出有界窗口。
                    try:
                        if datetime.fromisoformat(now_iso()) - datetime.fromisoformat(meta['started_at']) < timedelta(minutes=2):
                            continue
                    except (TypeError, ValueError):
                        pass
                    with self.store.transaction():
                        self.docs.set_generation(row['document_id'], 'failed', {'error': '生成请求没有被受理，请重试'})
                continue
            if message['status'] == 'streaming':
                continue
            info = json.loads(message['metadata_json'] or '{}')
            if message['status'] == 'completed' and info.get('candidate_id'):
                from ..creative_chat import CreativeChat
                try:
                    candidate = CreativeChat.candidate(self.store, self.account['id'], info['candidate_id'])
                    content = md_to_content(candidate['body'])
                    self.docs.replace_generated(row['document_id'], content, candidate['title'][:300],
                                                {'candidate_id': candidate['id'], 'finished_at': now_iso()})
                except (ValueError, KeyError) as error:
                    with self.store.transaction():
                        self.docs.set_generation(row['document_id'], 'failed', {'error': str(error)[:300]})
                continue
            if message['status'] == 'completed' and info.get('questions'):
                error = '模型提出了需要你回答的问题，请在助手中查看并回答后重新生成'
            elif message['status'] == 'completed':
                error = '模型回复没有形成完整初稿，请在助手中查看'
            elif message['status'] == 'stopped':
                error = '生成已停止'
            else:
                error = info.get('error_message') or '生成失败，请重试'
            with self.store.transaction():
                self.docs.set_generation(row['document_id'], 'cancelled' if message['status'] == 'stopped' else 'failed',
                                         {'error': str(error)[:300], 'finished_at': now_iso()})

    def ai_draft_start(self, params: dict) -> dict:
        brief = params.get('brief')
        if not isinstance(brief, str) or not 4 <= len(brief.strip()) <= 4000:
            raise DocumentError('请用 4–4000 字描述要写的文章')
        request_id = params.get('request_id') or new_id('docai').replace('-', '_')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', request_id):
            raise DocumentError('起草请求标识无效')
        origin_ref = 'ai-request:' + request_id
        existing = self.store.conn.execute('SELECT document_id FROM documents WHERE account_id=? AND origin=? AND origin_ref=?',
                                           (self.account['id'], 'ai', origin_ref)).fetchone()
        title = re.sub(r'\s+', ' ', brief.strip())[:40]
        meta = {'source_label': 'AI 初稿', 'brief': brief.strip(), 'started_at': now_iso(), 'request_id': request_id}
        # v3.16：起草时可选本篇技能；校验后存为本篇绑定，生成与之后的 AI 助手都按它解析。
        if params.get('skill_binding') is not None:
            from ..skills import WritingSkills
            binding = WritingSkills(self.store, self.account).validate_binding(params['skill_binding'])
            if binding:
                meta['skill_binding'] = binding
        # P1：一次生成两版对照时，两篇文章共享 variant_group，分别标“版本 A/B”。
        group, variant = params.get('variant_group'), params.get('variant')
        if group is not None or variant is not None:
            if not isinstance(group, str) or not re.fullmatch(r'vg-[A-Za-z0-9_-]{1,80}', group) or variant not in ('A', 'B'):
                raise DocumentError('版本对照参数无效')
            meta.update(variant_group=group, variant=variant, source_label=f'AI 初稿·版本{variant}')
        document = self.docs.create(title=title + '（生成中）', origin='ai', origin_ref=origin_ref, generation_state='running', version=False,
                                    meta=meta)
        if document['meta'].get('brief') != brief.strip():
            raise DocumentError('该起草请求已用于其他需求，请使用新的请求标识')
        return {'document': document, 'request_id': request_id, 'created': existing is None}

    def variants(self, params: dict) -> list[dict]:
        """同一次“两版对照”生成的所有文章（含自身），按版本排序。"""
        document = self.docs._row(self._id(params))
        group = document['meta'].get('variant_group')
        if not group:
            return []
        self.reconcile_generations()
        out = []
        for row in self.store.conn.execute("SELECT document_id FROM documents WHERE account_id=? AND origin='ai'",
                                           (self.account['id'],)).fetchall():
            item = self.docs._row(row['document_id'])
            if item['meta'].get('variant_group') != group:
                continue
            working = self.docs.working(item['document_id'])
            from .schema import word_count
            out.append({'document_id': item['document_id'], 'title': item['title'], 'variant': item['meta'].get('variant'),
                        'generation_state': item['generation_state'], 'lifecycle': item['lifecycle'],
                        'word_count': word_count(working['content']), 'current': item['document_id'] == document['document_id'],
                        'error': item['meta'].get('error', '')})
        return sorted(out, key=lambda v: v['variant'] or '')

    def ai_draft_bind(self, document_id: str, conversation_id: str, message_id: str | None, error: str | None) -> None:
        with self.store.transaction():
            if error:
                self.docs.set_generation(document_id, 'failed', {'conversation_id': conversation_id, 'error': error[:300]})
            else:
                extra = {'generated_skills': self._message_skills(message_id)} if message_id else {}
                self.docs.set_generation(document_id, 'running', {'conversation_id': conversation_id, 'message_id': message_id, **extra})

    def _message_skills(self, message_id: str) -> list[dict]:
        """v3.16：生成这篇初稿时实际使用的技能（来自会话请求快照；只存名称与版本）。"""
        from ..skills import skill_summary
        if not self._has_table('creative_messages'):
            return []
        row = self.store.conn.execute('SELECT metadata_json FROM creative_messages WHERE id=?', (message_id,)).fetchone()
        try:
            snapshot = json.loads(row['metadata_json'] or '{}')['request_snapshot']['writing_profile']['writing_skill_snapshot']
        except (TypeError, KeyError, ValueError):
            return []
        return skill_summary(snapshot)

    # ============================================================ v3.16 本篇技能
    def skill_binding(self, params: dict) -> dict:
        """documents.skill_binding：设置或清除本篇技能（binding 为 null 表示沿用系列/公众号设置）。"""
        from ..skills import WritingSkills
        document_id = self._id(params)
        if 'binding' not in params:
            raise DocumentError('请提供本篇技能选择，或传 null 沿用默认')
        skills = WritingSkills(self.store, self.account)
        binding = skills.validate_binding(params['binding'])
        with self.store.transaction():
            row = self.docs._row(document_id)
            meta = dict(row['meta'])
            if binding:
                meta['skill_binding'] = binding
            else:
                meta.pop('skill_binding', None)
            self.store.conn.execute('UPDATE documents SET meta_json=?, updated_at=? WHERE document_id=? AND account_id=?',
                                    (json.dumps(meta, ensure_ascii=False), now_iso(), document_id, self.account['id']))
        return skills.resolve_preview({'document_id': document_id})
