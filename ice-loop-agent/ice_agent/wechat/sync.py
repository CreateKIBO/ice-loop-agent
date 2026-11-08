"""v3.22 同步到公众号草稿箱。

流程（路线图 §6 的前四步；发布仍在公众号后台由作者确认）：
1. 预检：冻结交付版本，必须没有阻断问题；标题、封面、正文大小在接口限制内。
2. 上传资源：正文图片走 uploadimg（转成 jpg/png、<1MB），封面走永久素材；按“公众号 + AppID + 图片哈希”缓存，
   同一张图不重复上传，也不跨公众号复用远端地址。
3. 同步草稿：第一次新建；之后更新同一篇草稿。更新前回读后台草稿，和上次同步后的正文比对，
   作者在后台改过就先停下，让作者选择“另建一篇”或“覆盖”，不默认覆盖。
4. 回读与记录：写入后回读，记下后台正文的指纹；写一条 wechat_draft 交付记录（可据此登记发布）。

每次写草稿前先记操作日志；网络中断等“结果未知”时标为 unknown，下次同步先请作者到后台核对，
不盲目再建一篇。
"""
from __future__ import annotations

import hashlib
import html as htmllib
import io
import json
import re
import threading
from typing import Any

from ..documents.render import Renderer
from ..documents.schema import AUTHOR_LIMIT, TITLE_LIMIT, DocumentError
from ..domain.types import new_id, now_iso
from .client import UNKNOWN_OUTCOME, WeChatClient, WeChatError

APPID = re.compile(r'wx[0-9A-Za-z]{16}')
DIGEST_LIMIT = 120
CONTENT_IMAGE_LIMIT = 1024 * 1024 - 1024      # uploadimg：<1MB
COVER_LIMIT = 10 * 1024 * 1024
HTML_LIMIT = 1024 * 1024 - 1024               # draft content：<1MB
TEXT_LIMIT = 20_000                           # draft content：<2 万字符
GROUP_LIMIT = 8                               # 多图文最多 8 篇
_LOCKS: dict[tuple[str, str], threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def remote_fingerprint(content: str) -> str:
    """后台会改写 HTML（属性、样式、图片地址），只比对去掉标签与空白后的文字。"""
    text = htmllib.unescape(re.sub(r'<[^>]+>', '', content or ''))
    return hashlib.sha256(re.sub(r'\s+', '', text).encode('utf-8')).hexdigest()


def _lock(account_id: str, document_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault((account_id, document_id), threading.Lock())


def prepare_image(path: str, mime: str, size: int, *, cover: bool) -> tuple[str, bytes, str, str]:
    """返回 (文件名, 字节, mime, 说明)。正文图片：jpg/png 且 <1MB；封面：jpg/png/gif 且 ≤10MB。"""
    raw = open(path, 'rb').read()
    limit = COVER_LIMIT if cover else CONTENT_IMAGE_LIMIT
    allowed = ('image/jpeg', 'image/png', 'image/gif') if cover else ('image/jpeg', 'image/png')
    if mime in allowed and len(raw) <= limit:
        return ('cover' if cover else 'image') + {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif'}[mime], raw, mime, ''
    from PIL import Image
    with Image.open(io.BytesIO(raw)) as source:
        animated = getattr(source, 'is_animated', False)
        image = source.convert('RGBA') if source.mode in ('RGBA', 'LA', 'P') else source.convert('RGB')
    note = '动图已转为静态图；' if animated else ''
    if image.mode == 'RGBA':
        if mime == 'image/png' and not animated:
            buffer = io.BytesIO()
            image.save(buffer, 'PNG', optimize=True)
            if buffer.tell() <= limit:
                return 'image.png', buffer.getvalue(), 'image/png', note + '已压缩'
        flat = Image.new('RGB', image.size, (255, 255, 255))
        flat.paste(image, mask=image.split()[3])
        image = flat
    width = min(image.width, 1920)
    while True:
        frame = image if width == image.width else image.resize((width, max(1, round(image.height * width / image.width))), Image.LANCZOS)
        for quality in (90, 82, 74, 66, 58):
            buffer = io.BytesIO()
            frame.save(buffer, 'JPEG', quality=quality, optimize=True, progressive=True)
            if buffer.tell() <= limit:
                changed = '已转为 JPEG' if mime != 'image/jpeg' else '已压缩'
                return ('cover.jpg' if cover else 'image.jpg'), buffer.getvalue(), 'image/jpeg', \
                    note + changed + (f'（宽 {width}px）' if width != image.width else '')
        if width <= 320:
            raise DocumentError('图片压缩后仍超过接口限制，请换一张更小的图')
        width = int(width * 0.8)


class WeChatDrafts:
    def __init__(self, service: Any, store: Any, account: dict, transport=None):
        self.service, self.store, self.account = service, store, account
        self.transport = transport or getattr(service, 'wechat_transport', None)

    # ------------------------------------------------------------ 配置
    def _config(self) -> dict | None:
        row = self.store.conn.execute('SELECT * FROM wechat_config WHERE account_id=?', (self.account['id'],)).fetchone()
        return dict(row) if row else None

    def _secret(self) -> str:
        return (getattr(self.service, 'wechat_secrets', None) or {}).get(self.account['id'], '')

    def _client(self) -> tuple[WeChatClient, str]:
        config = self._config()
        if not config:
            raise DocumentError('还没有设置公众号接口：请先填写 AppID 与 AppSecret')
        secret = self._secret()
        if not secret:
            raise DocumentError('还没有保存 AppSecret（或应用重启后未能读取），请在“公众号接口”里重新保存')
        return WeChatClient(config['appid'], secret, self.transport), config['appid']

    def status(self, params: dict) -> dict:
        config = self._config() or {}
        out = {'configured': bool(config), 'appid': config.get('appid', ''), 'secret_set': bool(self._secret()),
               'last_check_at': config.get('last_check_at'), 'last_check_ok': bool(config.get('last_check_ok')) if config else None,
               'last_check_message': config.get('last_check_message', '')}
        document_id = params.get('document_id')
        if isinstance(document_id, str) and document_id and config:
            row = self.store.conn.execute('SELECT * FROM wechat_drafts WHERE account_id=? AND document_id=? AND appid=?',
                                          (self.account['id'], document_id, config['appid'])).fetchone()
            out['draft'] = ({k: row[k] for k in ('media_id', 'version_id', 'delivery_hash', 'synced_at')} if row else None)
            pending = self._unknown(document_id, config['appid'])
            out['unknown_operation'] = pending
            out['groups'] = self._groups_of(document_id, config['appid'])
        return out

    def _groups_of(self, document_id: str, appid: str) -> list[dict]:
        """v3.25 这篇文章所在的多图文：位置、同组文章标题、同步时间，以及它在草稿里的版本是不是最新的稳定版本。"""
        rows = self.store.conn.execute(
            'SELECT * FROM wechat_draft_groups WHERE account_id=? AND appid=? AND document_ids_json LIKE ? ORDER BY synced_at DESC',
            (self.account['id'], appid, '%' + json.dumps(document_id) + '%')).fetchall()
        head = self.store.conn.execute('SELECT head_version_id FROM documents WHERE document_id=? AND account_id=?',
                                       (document_id, self.account['id'])).fetchone()
        out = []
        for row in rows:
            ids = json.loads(row['document_ids_json'])
            if document_id not in ids:
                continue
            position = ids.index(document_id)
            members = json.loads(row['members_json'])
            titles = {r['document_id']: (r['title'], r['lifecycle']) for r in self.store.conn.execute(
                f'SELECT document_id, title, lifecycle FROM documents WHERE account_id=? AND document_id IN ({",".join("?" * len(ids))})',
                (self.account['id'], *ids))}
            synced_version = members[position].get('version_id') if position < len(members) else None
            out.append({'group_key': row['group_key'], 'media_id': row['media_id'], 'synced_at': row['synced_at'],
                        'position': position + 1, 'document_ids': ids,
                        'members': [{'document_id': i, 'title': titles.get(i, ('', ''))[0] or '未命名文章',
                                     'available': titles.get(i, ('', ''))[1] == 'active'} for i in ids],
                        'current': bool(head) and synced_version == head['head_version_id']})
        return out[:10]

    def configure(self, params: dict) -> dict:
        appid = params.get('appid')
        if not isinstance(appid, str) or not APPID.fullmatch(appid.strip()):
            raise DocumentError('AppID 格式不对：应为 wx 开头的 18 位开发者 ID')
        with self.store.transaction():
            self.store.conn.execute(
                'INSERT INTO wechat_config(account_id, appid, updated_at) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET '
                'appid=excluded.appid, updated_at=excluded.updated_at, last_check_at=NULL, last_check_ok=NULL, last_check_message=\'\'',
                (self.account['id'], appid.strip(), now_iso()))
        return self.status({})

    def test(self, params: dict) -> dict:
        client, _ = self._client()
        try:
            client.token(force=True)
            ok, message = True, '连接正常：已取得调用凭据'
        except WeChatError as error:
            ok, message = False, str(error)
        with self.store.transaction():
            self.store.conn.execute('UPDATE wechat_config SET last_check_at=?, last_check_ok=?, last_check_message=? WHERE account_id=?',
                                    (now_iso(), int(ok), message[:300], self.account['id']))
        return {**self.status({}), 'ok': ok, 'message': message}

    # ------------------------------------------------------------ 操作日志
    def _unknown(self, document_id: str, appid: str) -> dict | None:
        row = self.store.conn.execute(
            'SELECT op_id, action, state, created_at FROM wechat_operations WHERE account_id=? AND document_id=? AND appid=?'
            ' ORDER BY created_at DESC, rowid DESC LIMIT 1', (self.account['id'], document_id, appid)).fetchone()
        if row and row['state'] == 'unknown':
            return {'op_id': row['op_id'], 'action': row['action'], 'created_at': row['created_at']}
        return None

    def _op_start(self, document_id: str, appid: str, action: str, detail: dict) -> str:
        op_id = new_id('wxop')
        with self.store.transaction():
            self.store.conn.execute('INSERT INTO wechat_operations VALUES (?,?,?,?,?,?,?,?,?)',
                                    (op_id, self.account['id'], document_id, appid, action, 'started',
                                     json.dumps(detail, ensure_ascii=False), now_iso(), None))
        return op_id

    def _op_end(self, op_id: str, state: str, detail: dict | None = None) -> None:
        with self.store.transaction():
            self.store.conn.execute('UPDATE wechat_operations SET state=?, finished_at=?, detail_json=json_patch(detail_json, ?) WHERE op_id=?',
                                    (state, now_iso(), json.dumps(detail or {}, ensure_ascii=False), op_id))

    # ------------------------------------------------------------ 资源
    def _asset(self, appid: str, sha: str, kind: str) -> dict | None:
        row = self.store.conn.execute('SELECT remote_url, media_id FROM wechat_assets WHERE account_id=? AND appid=? AND sha256=? AND kind=?',
                                      (self.account['id'], appid, sha, kind)).fetchone()
        return dict(row) if row else None

    def _remember(self, appid: str, sha: str, kind: str, url: str = '', media_id: str = '') -> None:
        with self.store.transaction():
            self.store.conn.execute('INSERT OR REPLACE INTO wechat_assets VALUES (?,?,?,?,?,?,?)',
                                    (self.account['id'], appid, sha, kind, url, media_id, now_iso()))

    # ------------------------------------------------------------ 同步
    def _article(self, docs, client: WeChatClient, appid: str, rendered: dict, warnings: list[str], counts: dict) -> tuple[dict, dict]:
        """预检一篇冻结版本并上传它的图片与封面，返回 (草稿接口里的一篇文章, 封面)。"""
        blocking = [i for i in rendered['issues'] if i['severity'] == 'error']
        if blocking:
            raise DocumentError(f'还有 {len(blocking)} 个问题需要处理：{blocking[0]["message"]}')
        title = rendered['title'].strip()
        if not title:
            raise DocumentError('文章还没有标题')
        if len(title) > TITLE_LIMIT:
            raise DocumentError(f'标题 {len(title)} 字，超过公众号 {TITLE_LIMIT} 字上限')
        cover = rendered.get('cover')
        if not cover:
            raise DocumentError('草稿需要封面：请在“文章设置”里指定封面，或在正文里放一张图片')
        info = rendered['info']
        author = (info.get('author') or '').strip()
        if len(author) > AUTHOR_LIMIT:
            author = author[:AUTHOR_LIMIT]
            warnings.append(f'作者名超过 {AUTHOR_LIMIT} 字，已截断为“{author}”')
        digest = re.sub(r'\s+', ' ', info.get('summary') or '').strip()
        if len(digest) > DIGEST_LIMIT:
            digest = digest[:DIGEST_LIMIT]
            warnings.append(f'摘要超过 {DIGEST_LIMIT} 字，已截断')
        version = docs.docs.version(rendered['document_id'], rendered['version_id'])
        resolver = docs._resolver('bundle')
        urls: dict[str, str] = {}
        for image in rendered['images']:
            if image.get('missing'):
                continue
            hit = self._asset(appid, image['sha256'], 'content')
            if hit and hit['remote_url']:
                urls[image['block_id']] = hit['remote_url']
                counts['reused'] += 1
                continue
            source = resolver({'resourceId': image['resource_id']})
            if not source or source['sha256'] != image['sha256']:
                raise DocumentError(f'图{image["order"]}在同步期间发生变化，请重新同步')
            name, data, mime, note = prepare_image(source['file_path'], source['mime'], source['size'], cover=False)
            url = client.upload_content_image(name, data, mime)
            self._remember(appid, image['sha256'], 'content', url=url)
            urls[image['block_id']] = url
            counts['uploaded'] += 1
            if note:
                warnings.append(f'图{image["order"]}：{note}')
        hit = self._asset(appid, cover['sha256'], 'cover')
        if hit and hit['media_id']:
            thumb = hit['media_id']
        else:
            source = resolver({'resourceId': cover['resource_id']})
            if not source or source['sha256'] != cover['sha256']:
                raise DocumentError('封面在同步期间发生变化，请重新同步')
            name, data, mime, note = prepare_image(source['file_path'], source['mime'], source['size'], cover=True)
            thumb, _ = client.add_cover(name, data, mime)
            self._remember(appid, cover['sha256'], 'cover', media_id=thumb)
            counts['uploaded'] += 1
            if note:
                warnings.append(f'封面：{note}')
        local = Renderer(version['content'], resolve_image=lambda attrs: (
            {**src, 'data_url': (lambda _p, u=urls.get(attrs.get('id')): u)}
            if (src := resolver(attrs)) and urls.get(attrs.get('id')) else None)).run()
        content = local['html']
        if len(content.encode('utf-8')) > HTML_LIMIT or len(local['text']) > TEXT_LIMIT:
            raise DocumentError('正文超过草稿接口限制（少于 2 万字、HTML 小于 1MB），请拆成两篇或精简后再同步')
        article = {'title': title, 'author': author, 'digest': digest, 'content': content,
                   'content_source_url': (info.get('sourceUrl') or '').strip()[:500], 'thumb_media_id': thumb,
                   'need_open_comment': int(info.get('comments') in ('all', 'fans')),
                   'only_fans_can_comment': int(info.get('comments') == 'fans')}
        crop = info.get('coverCrop') or {}
        if crop.get('for') == cover['resource_id']:  # 裁切坐标只对当时选的那张封面有效
            for key, field in (('235', 'pic_crop_235_1'), ('11', 'pic_crop_1_1')):
                if crop.get(key):
                    article[field] = '_'.join(f'{v:g}' for v in crop[key])
        return article, cover

    def draft_sync(self, params: dict) -> dict:
        from ..documents.service import DocumentService
        docs = DocumentService(self.service, self.store, self.account)
        document_id = docs._id(params)
        mode = params.get('mode', 'auto')
        if mode not in ('auto', 'new', 'overwrite'):
            raise DocumentError('同步方式无效')
        lock = _lock(self.account['id'], document_id)
        if not lock.acquire(blocking=False):
            raise DocumentError('这篇文章正在同步到草稿箱，请稍候')
        try:
            return self._sync(docs, document_id, params, mode)
        finally:
            lock.release()

    def _sync(self, docs, document_id: str, params: dict, mode: str) -> dict:
        client, appid = self._client()
        pending = self._unknown(document_id, appid)
        if pending and not params.get('checked_unknown'):
            return {'needs_check': True, 'operation': pending,
                    'message': '上次同步在写入草稿时中断，结果未知。请先到公众号后台“草稿箱”看看有没有这篇，再选择继续。'}
        if pending:  # 作者已核对：这次照常同步（若后台已有一篇，作者可自行删除多余的那篇）
            self._op_end(pending['op_id'], 'failed', {'resolved_by_user': True})
        rendered = docs.render_delivery({k: v for k, v in params.items() if k in ('document_id', 'version_id', 'base_revision')},
                                        variant='bundle')
        warnings: list[str] = []
        counts = {'uploaded': 0, 'reused': 0}
        article, cover = self._article(docs, client, appid, rendered, warnings, counts)
        uploaded, reused = counts['uploaded'], counts['reused']
        existing = self.store.conn.execute('SELECT * FROM wechat_drafts WHERE account_id=? AND document_id=? AND appid=?',
                                           (self.account['id'], document_id, appid)).fetchone()
        action, media_id = 'created', None
        if existing and mode != 'new':
            remote = client.draft_get(existing['media_id'])
            if remote is None:
                warnings.append('后台已删除上次同步的草稿，已新建一篇')
                action = 'recreated'
            else:
                changed = existing['remote_text_hash'] and remote_fingerprint(remote.get('content', '')) != existing['remote_text_hash']
                if changed and mode == 'auto':
                    return {'conflict': True, 'media_id': existing['media_id'], 'synced_at': existing['synced_at'],
                            'message': '上次同步后，后台草稿的正文被修改过。可以另建一篇草稿，或用当前版本覆盖后台草稿。'}
                media_id, action = existing['media_id'], 'updated'
        op = self._op_start(document_id, appid, 'draft_update' if media_id else 'draft_add',
                            {'version_id': rendered['version_id'], 'delivery_hash': rendered['delivery_hash'], 'media_id': media_id or ''})
        try:
            if media_id:
                client.draft_update(media_id, article)
            else:
                media_id = client.draft_add(article)
        except WeChatError as error:
            self._op_end(op, 'unknown' if error.outcome == UNKNOWN_OUTCOME else 'failed', {'error': str(error)})
            raise DocumentError(str(error) + ('；结果未知，请到后台草稿箱核对后再同步' if error.outcome == UNKNOWN_OUTCOME else '')) from error
        self._op_end(op, 'succeeded', {'media_id': media_id})
        try:
            remote = client.draft_get(media_id)
            fingerprint = remote_fingerprint(remote.get('content', '')) if remote else ''
        except WeChatError:
            fingerprint = ''
            warnings.append('草稿已写入，但回读失败；下次同步不会检查后台改动')
        synced_at = now_iso()
        with self.store.transaction():
            self.store.conn.execute('INSERT OR REPLACE INTO wechat_drafts VALUES (?,?,?,?,?,?,?,?)',
                                    (self.account['id'], document_id, appid, media_id, rendered['version_id'],
                                     rendered['delivery_hash'], fingerprint, synced_at))
        delivery_id = docs.docs.record_delivery(document_id=document_id, version_id=rendered['version_id'],
                                                delivery_hash=rendered['delivery_hash'], kind='wechat_draft',
                                                destination='wechat-draft:' + media_id, issues=rendered['issues'])
        return {'media_id': media_id, 'action': action, 'version_id': rendered['version_id'], 'synced_at': synced_at,
                'uploaded': uploaded, 'reused': reused, 'warnings': warnings, 'delivery_id': delivery_id,
                'note': '已同步到草稿箱，还没有发布；请在公众号后台预览、发布，再回来登记发布。'}

    # ------------------------------------------------------------ 多图文（v3.24）
    def _group_ids(self, params: dict) -> list[str]:
        ids = params.get('document_ids')
        if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
            raise DocumentError('请选择要合成多图文的文章')
        if len(set(ids)) != len(ids):
            raise DocumentError('同一篇文章不能在多图文里出现两次')
        if not 2 <= len(ids) <= GROUP_LIMIT:
            raise DocumentError(f'多图文需要 2 到 {GROUP_LIMIT} 篇文章（第一篇为头条）')
        return ids

    @staticmethod
    def group_key(ids: list[str]) -> str:
        return hashlib.sha256('\n'.join(ids).encode('utf-8')).hexdigest()[:24]

    def _group_row(self, appid: str, key: str) -> dict | None:
        row = self.store.conn.execute('SELECT * FROM wechat_draft_groups WHERE account_id=? AND appid=? AND group_key=?',
                                      (self.account['id'], appid, key)).fetchone()
        if not row:
            return None
        return {'media_id': row['media_id'], 'synced_at': row['synced_at'], 'members': json.loads(row['members_json'])}

    def _member(self, docs, document_id: str) -> tuple[dict, dict | None, str]:
        """多图文用每篇文章最近的稳定版本，不在这里替作者保存工作副本。返回 (文章, 渲染结果或 None, 不能同步的原因)。"""
        document = docs.docs.get(document_id)
        if document['lifecycle'] != 'active':
            return document, None, '在回收站里'
        if document['generation_state'] == 'running':
            return document, None, 'AI 初稿仍在生成'
        head = document.get('head_version')
        if not head:
            return document, None, '还没有稳定版本：先在编辑器里保存一个版本'
        rendered = docs.render_delivery({'document_id': document_id, 'version_id': head['version_id']}, variant='bundle')
        blocking = [i for i in rendered['issues'] if i['severity'] == 'error']
        if blocking:
            return document, rendered, f'有 {len(blocking)} 个阻断问题：{blocking[0]["message"]}'
        if not rendered['title'].strip():
            return document, rendered, '还没有标题'
        if len(rendered['title'].strip()) > TITLE_LIMIT:
            return document, rendered, f'标题超过 {TITLE_LIMIT} 字'
        if not rendered.get('cover'):
            return document, rendered, '没有封面：在“文章设置”里指定，或在正文里放一张图'
        return document, rendered, ''

    def group_preview(self, params: dict) -> dict:
        """合成前的检查：每篇用哪个版本、能不能同步；这组文章以前有没有同步过。不访问网络。"""
        from ..documents.service import DocumentService
        docs = DocumentService(self.service, self.store, self.account)
        ids = self._group_ids(params)
        items = []
        for document_id in ids:
            document, rendered, problem = self._member(docs, document_id)
            items.append({'document_id': document_id, 'title': document['title'],
                          'version_id': rendered['version_id'] if rendered else None,
                          'version_created_at': rendered['version_created_at'] if rendered else None,
                          'unversioned': bool(document['unversioned_changes']) and bool(document.get('head_version')),
                          'problem': problem})
        config = self._config()
        group = self._group_row(config['appid'], self.group_key(ids)) if config else None
        if group:
            group = {**group, 'current': [m.get('version_id') for m in group['members']] == [i['version_id'] for i in items]}
        return {'items': items, 'ready': not any(i['problem'] for i in items), 'group': group,
                'configured': bool(config), 'secret_set': bool(self._secret()),
                'unknown_operation': self._unknown('group:' + self.group_key(ids), config['appid']) if config else None}

    def group_sync(self, params: dict) -> dict:
        from ..documents.service import DocumentService
        docs = DocumentService(self.service, self.store, self.account)
        ids = self._group_ids(params)
        mode = params.get('mode', 'auto')
        if mode not in ('auto', 'new', 'overwrite'):
            raise DocumentError('同步方式无效')
        key = self.group_key(ids)
        locks = [_lock(self.account['id'], 'group:' + key)] + [_lock(self.account['id'], i) for i in ids]
        held = []
        try:
            for lock in locks:
                if not lock.acquire(blocking=False):
                    raise DocumentError('其中有文章正在同步到草稿箱，请稍候')
                held.append(lock)
            return self._group_sync(docs, ids, key, params, mode)
        finally:
            for lock in held:
                lock.release()

    def _group_sync(self, docs, ids: list[str], key: str, params: dict, mode: str) -> dict:
        client, appid = self._client()
        op_doc = 'group:' + key
        pending = self._unknown(op_doc, appid)
        if pending and not params.get('checked_unknown'):
            return {'needs_check': True, 'operation': pending,
                    'message': '上次同步这组多图文时中断，结果未知。请先到公众号后台“草稿箱”看看有没有这篇，再选择继续。'}
        if pending:
            self._op_end(pending['op_id'], 'failed', {'resolved_by_user': True})
        expected = params.get('version_ids')
        warnings: list[str] = []
        counts = {'uploaded': 0, 'reused': 0}
        articles, members = [], []
        for position, document_id in enumerate(ids):
            document, rendered, problem = self._member(docs, document_id)
            name = f'第{position + 1}篇《{document["title"] or "未命名"}》'
            if problem:
                raise DocumentError(f'{name}{problem}')
            if isinstance(expected, list) and len(expected) == len(ids) and expected[position] != rendered['version_id']:
                raise DocumentError(f'{name}在检查之后保存了新版本，请重新检查后再同步')
            if document['unversioned_changes']:
                warnings.append(f'{name}：工作副本里还有没保存成版本的修改，这次用的是最近的稳定版本')
            local: list[str] = []
            article, _ = self._article(docs, client, appid, rendered, local, counts)
            warnings += [f'{name}：{w}' for w in local]
            articles.append(article)
            members.append({'document_id': document_id, 'version_id': rendered['version_id'],
                            'delivery_hash': rendered['delivery_hash'], 'issues': rendered['issues']})
        existing = self._group_row(appid, key)
        action, media_id = 'created', None
        if existing and mode != 'new':
            remote = client.draft_items(existing['media_id'])
            if remote is None:
                warnings.append('后台已删除上次同步的多图文草稿，已新建一篇')
                action = 'recreated'
            else:
                stored = existing['members']
                changed = len(remote) != len(stored) or any(
                    m.get('remote_text_hash') and remote_fingerprint(r.get('content', '')) != m['remote_text_hash']
                    for r, m in zip(remote, stored))
                if changed and mode == 'auto':
                    return {'conflict': True, 'media_id': existing['media_id'], 'synced_at': existing['synced_at'],
                            'message': '上次同步后，后台这篇多图文被修改过（正文改动或篇目增减）。可以另建一篇草稿，或用当前版本覆盖。'}
                if len(remote) != len(stored):  # 篇目被增减：接口不能按位置覆盖，只能另建
                    warnings.append('后台草稿的篇目数已变化，不能逐篇覆盖，已另建一篇')
                    action = 'recreated'
                else:
                    media_id, action = existing['media_id'], 'updated'
        if media_id:
            done = self._group_update(client, appid, op_doc, media_id, articles, members, existing['members'], mode == 'overwrite')
        else:
            op = self._op_start(op_doc, appid, 'draft_add_group', {'document_ids': ids, 'versions': [m['version_id'] for m in members]})
            try:
                media_id = client.draft_add(articles)
            except WeChatError as error:
                self._op_end(op, 'unknown' if error.outcome == UNKNOWN_OUTCOME else 'failed', {'error': str(error)})
                raise DocumentError(str(error) + ('；结果未知，请到后台草稿箱核对后再同步' if error.outcome == UNKNOWN_OUTCOME else '')) from error
            self._op_end(op, 'succeeded', {'media_id': media_id})
            done = list(range(len(ids)))
        synced_at = self._group_save(client, appid, key, ids, media_id, members, done, existing, warnings)
        for position in done:
            m = members[position]
            docs.docs.record_delivery(document_id=m['document_id'], version_id=m['version_id'], delivery_hash=m['delivery_hash'],
                                      kind='wechat_draft', destination=f'wechat-draft:{media_id}#{position + 1}', issues=m['issues'])
        return {'media_id': media_id, 'action': action, 'synced_at': synced_at, 'count': len(ids),
                'version_ids': [m['version_id'] for m in members], 'uploaded': counts['uploaded'], 'reused': counts['reused'],
                'warnings': warnings,
                'note': f'已把 {len(ids)} 篇文章同步为一篇多图文草稿，还没有发布；请在公众号后台预览、发布，再回来逐篇登记发布。'}

    def _group_update(self, client, appid: str, op_doc: str, media_id: str, articles: list[dict], members: list[dict],
                      stored: list[dict], overwrite: bool) -> list[int]:
        """接口一次只能更新一篇：只更新版本变了的位置（覆盖时全部更新）；中途失败时，已更新的位置照样记下，再报错。"""
        targets = [] if overwrite else [i for i, (m, old) in enumerate(zip(members, stored))
                                        if m['delivery_hash'] != old.get('delivery_hash')]
        targets = targets or list(range(len(members)))
        op = self._op_start(op_doc, appid, 'draft_update_group', {'media_id': media_id, 'positions': [i + 1 for i in targets]})
        done: list[int] = []
        for position in targets:
            try:
                client.draft_update(media_id, articles[position], index=position)
            except WeChatError as error:
                unknown = error.outcome == UNKNOWN_OUTCOME
                self._op_end(op, 'unknown' if unknown else 'failed', {'error': str(error), 'done': [i + 1 for i in done]})
                self._group_save(client, appid, op_doc[6:], [m['document_id'] for m in members], media_id, members, done,
                                 {'members': stored}, [])
                raise DocumentError(f'第{position + 1}篇没有更新成功：{error}' +
                                    (f'（前面 {len(done)} 篇已更新）' if done else '') +
                                    ('；结果未知，请到后台草稿箱核对后再同步' if unknown else '')) from error
            done.append(position)
        self._op_end(op, 'succeeded', {'media_id': media_id})
        return done

    def _group_save(self, client, appid: str, key: str, ids: list[str], media_id: str, members: list[dict], done: list[int],
                    existing: dict | None, warnings: list[str]) -> str:
        """回读后台正文指纹并保存每个位置的记录；没更新的位置保留原来的版本记录。"""
        try:
            remote = client.draft_items(media_id) or []
        except WeChatError:
            remote = []
            warnings.append('草稿已写入，但回读失败；下次同步不会检查后台改动')
        old = (existing or {}).get('members') or []
        saved = []
        for i, m in enumerate(members):
            base = {k: m[k] for k in ('document_id', 'version_id', 'delivery_hash')} if i in done or i >= len(old) else \
                {k: old[i].get(k) for k in ('document_id', 'version_id', 'delivery_hash')}
            saved.append({**base, 'remote_text_hash': remote_fingerprint(remote[i].get('content', '')) if i < len(remote) else ''})
        synced_at = now_iso()
        with self.store.transaction():
            self.store.conn.execute('INSERT OR REPLACE INTO wechat_draft_groups VALUES (?,?,?,?,?,?,?)',
                                    (self.account['id'], appid, key, json.dumps(ids), media_id,
                                     json.dumps(saved, ensure_ascii=False), synced_at))
        return synced_at

    def resolve_unknown(self, params: dict) -> dict:
        """作者已到后台核对“结果未知”的那次写入：标记为已处理（找到了就记下草稿 ID）。"""
        _, appid = self._client()
        document_id = params.get('document_id')
        pending = self._unknown(str(document_id or ''), appid)
        if not pending:
            return self.status({'document_id': document_id})
        self._op_end(pending['op_id'], 'failed', {'resolved_by_user': True})
        return self.status({'document_id': document_id})
