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
            return self.import_image_bytes(base64.b64decode(match.group(2), validate=False), alt or '粘贴图片')
        except (DocumentError, ValueError, binascii.Error, OSError):
            return None

    # ============================================================ images
    def import_image_bytes(self, data: bytes, title: str) -> dict:
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
            resource = self._resource_from_file(temp, title, {'kind': 'paste', 'converted_from': converted or ''})
        finally:
            temp.unlink(missing_ok=True)
        return resource

    def image_import(self, params: dict) -> dict:
        """桌面主进程经系统对话框选择文件后调用（渲染层不提供路径）。"""
        path = Path(str(params.get('file_path', '')))
        if not path.is_file():
            raise DocumentError('图片文件不存在')
        resource = self.import_image_bytes(path.read_bytes(), path.stem)
        return self._image_view(resource)

    def image_import_data(self, params: dict) -> dict:
        match = _DATA_URL.match(str(params.get('data_url', ''))[:45_000_000])
        if not match:
            raise DocumentError('剪贴板图片格式无效')
        try:
            data = base64.b64decode(match.group(2), validate=False)
        except binascii.Error:
            raise DocumentError('剪贴板图片数据无效') from None
        return self._image_view(self.import_image_bytes(data, str(params.get('name') or '粘贴图片')[:100]))

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
                'preview': preview, 'ok': ok}

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
                return image_data_url(path, mime, preview=True)
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
        return self.docs.create(title=candidate['title'], content=content, origin='ai', origin_ref=candidate['id'],
                                series=(candidate['base'] or {}).get('series') or None,
                                meta={'source_label': 'AI 初稿', 'conversation_id': candidate['conversation_id'],
                                      'candidate_id': candidate['id']}, producer='ai')

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
        document = self.docs.create(title=title + '（生成中）', origin='ai', origin_ref=origin_ref, generation_state='running', version=False,
                                    meta={'source_label': 'AI 初稿', 'brief': brief.strip(), 'started_at': now_iso(),
                                          'request_id': request_id})
        if document['meta'].get('brief') != brief.strip():
            raise DocumentError('该起草请求已用于其他需求，请使用新的请求标识')
        return {'document': document, 'request_id': request_id, 'created': existing is None}

    def ai_draft_bind(self, document_id: str, conversation_id: str, message_id: str | None, error: str | None) -> None:
        with self.store.transaction():
            if error:
                self.docs.set_generation(document_id, 'failed', {'conversation_id': conversation_id, 'error': error[:300]})
            else:
                self.docs.set_generation(document_id, 'running', {'conversation_id': conversation_id, 'message_id': message_id})
