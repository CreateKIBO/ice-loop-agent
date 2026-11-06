"""普通文章存储（A-01/A-02/A-03）。

- documents：文章身份与来源映射，栏目/期号可空，不依赖 job。
- document_working：唯一可编辑工作副本（revision 乐观并发）。
- document_versions：不可变稳定版本；恢复=把某版本内容写回工作副本并另记一版。
旧草稿/旧任务文章只在用户打开时按映射接入（不批量改写旧正文）。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from ..domain.types import new_id, now_iso, sha256_json, sha256_text
from .schema import (DocumentError, content_hash, derive_title, empty_content, normalize, summary,
                     word_count, image_refs)

CHECKPOINT_AFTER = timedelta(minutes=15)
ORIGINS = ('blank', 'paste', 'import', 'ai', 'copy', 'legacy_draft', 'legacy_job')


def _cover_of(content: dict | None) -> str | None:
    """左栏卡片与列表缩略图：文章设置里指定的封面，否则正文第一张图。"""
    if not content:
        return None
    cover = (content.get('info') or {}).get('coverResourceId')
    if cover:
        return cover
    refs = image_refs(content)
    return refs[0].get('resourceId') if refs else None


class WorkingConflict(DocumentError):
    def __init__(self, server: dict):
        super().__init__('文章已在其他窗口或更早的保存中更新；你的修改仍保留在编辑器里')
        self.server = server


def _title(value: Any, content: dict | None = None) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return derive_title(content) if content else '未命名文章'
    if not isinstance(value, str) or len(value.strip()) > 300:
        raise DocumentError('标题最多 300 字')
    return value.strip()


class DocumentStore:
    def __init__(self, store: Any, account_id: str):
        self.store = store
        self.conn = store.conn
        self.account_id = account_id

    # ----------------------------------------------------------------- read
    def _row(self, document_id: str) -> dict:
        row = self.conn.execute('SELECT * FROM documents WHERE document_id=? AND account_id=?',
                                (document_id, self.account_id)).fetchone()
        if not row:
            raise DocumentError('当前公众号没有这篇文章')
        value = dict(row)
        value['meta'] = json.loads(value.pop('meta_json') or '{}')
        return value

    def working(self, document_id: str) -> dict:
        row = self.conn.execute('SELECT * FROM document_working WHERE document_id=? AND account_id=?',
                                (document_id, self.account_id)).fetchone()
        if not row:
            raise DocumentError('文章工作副本缺失，请从版本历史恢复')
        value = dict(row)
        value['content'] = json.loads(value.pop('content_json'))
        return value

    def head(self, document: dict) -> dict | None:
        if not document.get('head_version_id'):
            return None
        return self.version(document['document_id'], document['head_version_id'], content=False)

    def get(self, document_id: str) -> dict:
        document = self._row(document_id)
        working = self.working(document_id)
        head = self.head(document)
        return {**document, 'content': working['content'], 'revision': working['revision'],
                'content_hash': working['content_hash'], 'base_version_id': working['base_version_id'],
                'working_updated_at': working['updated_at'],
                'head_version': head,
                'unversioned_changes': not head or head['content_hash'] != working['content_hash'] or head['title'] != document['title'],
                'word_count': word_count(working['content']),
                'publications': self.publications(document_id)}

    def summary_row(self, row: dict) -> dict:
        content = json.loads(row['content_json']) if row.get('content_json') else None
        meta = json.loads(row.get('meta_json') or '{}')
        return {'id': row['document_id'], 'document_id': row['document_id'], 'kind': 'document',
                'title': row['title'], 'origin': row['origin'], 'origin_ref': row['origin_ref'],
                'series': row['series'], 'episode': row['episode'], 'lifecycle': row['lifecycle'],
                'generation_state': row['generation_state'], 'updated_at': row['updated_at'],
                'created_at': row['created_at'], 'trashed_at': row['trashed_at'],
                'summary': summary(content) if content else '', 'word_count': word_count(content) if content else 0,
                'images': len(image_refs(content)) if content else 0,
                'published': bool(row.get('published')), 'readonly': False,
                'source_label': meta.get('source_label', ''), 'variant': meta.get('variant'),
                'cover_resource_id': _cover_of(content),
                'planned_date': meta.get('planned_date'),
                'variant_group': meta.get('variant_group')}

    def list(self, *, lifecycle: str = 'active', query: str = '') -> list[dict]:
        rows = self.conn.execute(
            'SELECT d.*, w.content_json,'
            ' EXISTS(SELECT 1 FROM publication_records p WHERE p.document_id=d.document_id AND p.state=\'active\') AS published'
            ' FROM documents d JOIN document_working w ON w.document_id=d.document_id'
            ' WHERE d.account_id=? AND d.lifecycle=? ORDER BY d.updated_at DESC',
            (self.account_id, lifecycle)).fetchall()
        query = query.casefold()
        items = [self.summary_row(dict(r)) for r in rows]
        return [i for i in items if not query or query in (i['title'] + i['summary']).casefold()]

    def mapped_refs(self) -> dict[tuple[str, str], str]:
        rows = self.conn.execute("SELECT origin, origin_ref, document_id FROM documents WHERE account_id=? AND origin_ref<>''",
                                 (self.account_id,)).fetchall()
        return {(r['origin'], r['origin_ref']): r['document_id'] for r in rows}

    # ---------------------------------------------------------------- write
    def create(self, *, title: Any = None, content: dict | None = None, origin: str = 'blank',
               origin_ref: str = '', series: str | None = None, episode: int | None = None,
               meta: dict | None = None, producer: str = 'user', note: str = '',
               generation_state: str = 'none', version: bool = True) -> dict:
        if origin not in ORIGINS:
            raise DocumentError('文章来源无效')
        if series is not None and (not isinstance(series, str) or len(series) > 40):
            raise DocumentError('栏目代码无效')
        if episode is not None and (type(episode) is not int or not 0 < episode < 100000):
            raise DocumentError('期号需为正整数或留空')
        content = normalize(content) if content is not None else empty_content()
        title = _title(title, content if origin != 'blank' else None)
        document_id = new_id('doc')
        now = now_iso()
        digest = content_hash(content)
        with self.store.transaction():
            if origin_ref:
                existing = self.conn.execute('SELECT document_id FROM documents WHERE account_id=? AND origin=? AND origin_ref=?',
                                             (self.account_id, origin, origin_ref)).fetchone()
                if existing:
                    return self.get(existing['document_id'])
            self.conn.execute(
                'INSERT INTO documents(document_id,account_id,title,origin,origin_ref,series,episode,lifecycle,'
                'generation_state,meta_json,head_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (document_id, self.account_id, title, origin, origin_ref, series or None, episode, 'active',
                 generation_state, json.dumps(meta or {}, ensure_ascii=False), None, now, now))
            self.conn.execute(
                'INSERT INTO document_working VALUES (?,?,?,?,?,?,?,?)',
                (document_id, self.account_id, json.dumps(content, ensure_ascii=False), content['schema'],
                 None, digest, 1, now))
            if version:
                self._insert_version(document_id, content, title, producer, note or {
                    'blank': '新建文章', 'paste': '粘贴导入', 'import': '文件导入', 'ai': 'AI 初稿',
                    'copy': '复制为新文章', 'legacy_draft': '从旧草稿接入', 'legacy_job': '从旧任务文章接入'}[origin])
        return self.get(document_id)

    def _insert_version(self, document_id: str, content: dict, title: str, producer: str, note: str) -> str:
        parent = self.conn.execute('SELECT head_version_id FROM documents WHERE document_id=?', (document_id,)).fetchone()
        version_id = new_id('ver')
        now = now_iso()
        self.conn.execute('INSERT INTO document_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                          (version_id, document_id, self.account_id, parent['head_version_id'] if parent else None,
                           json.dumps(content, ensure_ascii=False), content['schema'], content_hash(content),
                           title, producer, note[:200], now))
        self.conn.execute('UPDATE documents SET head_version_id=?, updated_at=? WHERE document_id=?',
                          (version_id, now, document_id))
        self.conn.execute('UPDATE document_working SET base_version_id=? WHERE document_id=?', (version_id, document_id))
        return version_id

    def save_working(self, document_id: str, content: Any, *, base_revision: Any, title: Any = None,
                     force: bool = False) -> dict:
        if type(base_revision) is not int:
            raise DocumentError('缺少工作副本修订号')
        content = normalize(content)
        digest = content_hash(content)
        with self.store.transaction():
            document = self._row(document_id)
            if document['lifecycle'] != 'active':
                raise DocumentError('文章在回收站中，请先恢复')
            working = self.working(document_id)
            if working['revision'] != base_revision and not force:
                raise WorkingConflict({'revision': working['revision'], 'content_hash': working['content_hash'],
                                       'updated_at': working['updated_at'], 'content': working['content']})
            new_title = _title(title, None) if title is not None else document['title']
            if digest == working['content_hash'] and new_title == document['title']:
                return {'document_id': document_id, 'revision': working['revision'], 'content_hash': digest,
                        'saved_at': working['updated_at'], 'unchanged': True, 'checkpoint': None}
            now = now_iso()
            revision = working['revision'] + 1
            self.conn.execute('UPDATE document_working SET content_json=?, schema_version=?, content_hash=?, revision=?,'
                              ' updated_at=? WHERE document_id=?',
                              (json.dumps(content, ensure_ascii=False), content['schema'], digest, revision, now, document_id))
            self.conn.execute('UPDATE documents SET title=?, updated_at=? WHERE document_id=?', (new_title, now, document_id))
            checkpoint = None
            head = self.head(document)
            if head and (head['content_hash'] != digest or head['title'] != new_title):
                created = datetime.fromisoformat(head['created_at'])
                if datetime.fromisoformat(now) - created >= CHECKPOINT_AFTER:
                    checkpoint = self._insert_version(document_id, content, new_title, 'checkpoint', '自动检查点')
        return {'document_id': document_id, 'revision': revision, 'content_hash': digest, 'saved_at': now,
                'unchanged': False, 'checkpoint': checkpoint}

    def commit_version(self, document_id: str, *, base_revision: Any, note: str = '', producer: str = 'user') -> dict:
        with self.store.transaction():
            document = self._row(document_id)
            working = self.working(document_id)
            if type(base_revision) is not int or working['revision'] != base_revision:
                raise DocumentError('工作副本还有未写入的修改，请等待自动保存完成后再保存版本')
            head = self.head(document)
            if head and head['content_hash'] == working['content_hash'] and head['title'] == document['title']:
                return {'version_id': head['version_id'], 'created': False}
            if not isinstance(note, str) or len(note) > 200:
                raise DocumentError('版本说明最多 200 字')
            version_id = self._insert_version(document_id, working['content'], document['title'], producer,
                                              note.strip() or '手动保存版本')
        return {'version_id': version_id, 'created': True}

    def versions(self, document_id: str) -> list[dict]:
        self._row(document_id)
        rows = self.conn.execute('SELECT version_id,parent_version_id,content_hash,title,producer,note,created_at,'
                                 'content_json FROM document_versions WHERE document_id=? AND account_id=?'
                                 ' ORDER BY created_at DESC, rowid DESC', (document_id, self.account_id)).fetchall()
        published = {r['version_id'] for r in self.conn.execute(
            "SELECT version_id FROM publication_records WHERE document_id=? AND state='active'", (document_id,))}
        out = []
        for row in rows:
            content = json.loads(row['content_json'])
            out.append({k: row[k] for k in ('version_id', 'parent_version_id', 'content_hash', 'title', 'producer',
                                            'note', 'created_at')} |
                       {'word_count': word_count(content), 'images': len(image_refs(content)),
                        'published': row['version_id'] in published})
        return out

    def version(self, document_id: str, version_id: str, *, content: bool = True) -> dict:
        row = self.conn.execute('SELECT * FROM document_versions WHERE version_id=? AND document_id=? AND account_id=?',
                                (version_id, document_id, self.account_id)).fetchone()
        if not row:
            raise DocumentError('版本不存在或属于其他文章')
        value = dict(row)
        data = value.pop('content_json')
        if content:
            value['content'] = json.loads(data)
        return value

    def restore(self, document_id: str, version_id: str, *, base_revision: Any) -> dict:
        version = self.version(document_id, version_id)
        with self.store.transaction():
            working = self.working(document_id)
            document = self._row(document_id)
            if type(base_revision) is not int or working['revision'] != base_revision:
                raise DocumentError('工作副本已更新，请重新打开版本历史后恢复')
            head = self.head(document)
            # 恢复前若有未成版的修改，先固化，恢复本身可再撤回。
            if not head or head['content_hash'] != working['content_hash'] or head['title'] != document['title']:
                self._insert_version(document_id, working['content'], document['title'], 'autosave', '恢复前自动保存')
            now = now_iso()
            content = version['content']
            self.conn.execute('UPDATE document_working SET content_json=?, content_hash=?, revision=revision+1, updated_at=?'
                              ' WHERE document_id=?', (json.dumps(content, ensure_ascii=False), version['content_hash'],
                                                      now, document_id))
            self.conn.execute('UPDATE documents SET title=?, updated_at=? WHERE document_id=?',
                              (version['title'], now, document_id))
            self._insert_version(document_id, content, version['title'], 'restore',
                                 f"恢复到 {version['created_at'][:16].replace('T', ' ')} 的版本")
        return self.get(document_id)

    def update_meta(self, document_id: str, params: dict) -> dict:
        with self.store.transaction():
            document = self._row(document_id)
            series = params.get('series', document['series'])
            episode = params.get('episode', document['episode'])
            if series is not None and (not isinstance(series, str) or len(series) > 40):
                raise DocumentError('栏目代码无效')
            if episode is not None and (type(episode) is not int or not 0 < episode < 100000):
                raise DocumentError('期号需为正整数或留空')
            title = _title(params['title']) if 'title' in params else document['title']
            self.conn.execute('UPDATE documents SET title=?, series=?, episode=?, updated_at=? WHERE document_id=?',
                              (title, series or None, episode, now_iso(), document_id))
        return self.get(document_id)

    def set_lifecycle(self, document_id: str, lifecycle: str) -> dict:
        if lifecycle not in ('active', 'trashed'):
            raise DocumentError('文章状态无效')
        with self.store.transaction():
            self._row(document_id)
            now = now_iso()
            self.conn.execute('UPDATE documents SET lifecycle=?, trashed_at=?, updated_at=? WHERE document_id=?',
                              (lifecycle, now if lifecycle == 'trashed' else None, now, document_id))
        return self._row(document_id)

    def set_generation(self, document_id: str, state: str, meta: dict | None = None) -> None:
        document = self._row(document_id)
        merged = {**document['meta'], **(meta or {})}
        self.conn.execute('UPDATE documents SET generation_state=?, meta_json=?, updated_at=? WHERE document_id=?',
                          (state, json.dumps(merged, ensure_ascii=False), now_iso(), document_id))

    def replace_generated(self, document_id: str, content: dict, title: str, meta: dict) -> None:
        """AI 初稿落地：只在文章仍处于生成中、且用户未编辑时写入（不覆盖用户修改）。"""
        content = normalize(content)
        with self.store.transaction():
            document = self._row(document_id)
            working = self.working(document_id)
            if document['generation_state'] != 'running':
                return
            now = now_iso()
            if working['revision'] == 1:
                self.conn.execute('UPDATE document_working SET content_json=?, content_hash=?, revision=2, updated_at=?'
                                  ' WHERE document_id=?', (json.dumps(content, ensure_ascii=False), content_hash(content),
                                                          now, document_id))
                self.conn.execute('UPDATE documents SET title=? WHERE document_id=?', (title, document_id))
                self._insert_version(document_id, content, title, 'ai', 'AI 初稿生成完成')
            else:
                # 用户已在生成期间写了内容：结果另存为独立新文章，绝不覆盖。
                meta = {**meta, 'collision': True}
                self.create(title=title + '（AI 初稿）', content=content, origin='ai', producer='ai',
                            note='AI 初稿生成完成（原文章生成期间已被编辑）', meta={'source_label': 'AI 初稿', **meta})
            self.set_generation(document_id, 'ready', meta)

    # ------------------------------------------------------------- imports
    def record_import(self, *, document_id: str | None, kind: str, original: str, report: dict) -> str:
        import_id = new_id('imp')
        self.conn.execute('INSERT INTO document_import_originals VALUES (?,?,?,?,?,?,?,?)',
                          (import_id, document_id, self.account_id, kind, original, sha256_text(original),
                           json.dumps(report, ensure_ascii=False), now_iso()))
        return import_id

    def import_original(self, import_id: str) -> dict:
        row = self.conn.execute('SELECT * FROM document_import_originals WHERE import_id=? AND account_id=?',
                                (import_id, self.account_id)).fetchone()
        if not row:
            raise DocumentError('导入原件不存在或属于其他公众号')
        value = dict(row)
        value['report'] = json.loads(value.pop('report_json'))
        return value

    def bind_import(self, import_id: str, document_id: str) -> None:
        self.conn.execute('UPDATE document_import_originals SET document_id=? WHERE import_id=? AND account_id=?',
                          (document_id, import_id, self.account_id))

    def imports(self, document_id: str) -> list[dict]:
        rows = self.conn.execute('SELECT import_id,kind,original_hash,report_json,created_at,length(original) AS size'
                                 ' FROM document_import_originals WHERE document_id=? AND account_id=? ORDER BY created_at DESC',
                                 (document_id, self.account_id)).fetchall()
        return [{**{k: r[k] for k in ('import_id', 'kind', 'original_hash', 'created_at', 'size')},
                 'report': json.loads(r['report_json'])} for r in rows]

    # ----------------------------------------------------------- delivery
    def record_delivery(self, *, document_id: str, version_id: str, delivery_hash: str, kind: str,
                        destination: str = '', issues: list | None = None) -> str:
        delivery_id = new_id('dlv')
        self.conn.execute('INSERT INTO document_deliveries VALUES (?,?,?,?,?,?,?,?,?)',
                          (delivery_id, document_id, self.account_id, version_id, delivery_hash, kind, destination,
                           json.dumps(issues or [], ensure_ascii=False), now_iso()))
        self.conn.commit()
        return delivery_id

    def deliveries(self, document_id: str) -> list[dict]:
        rows = self.conn.execute('SELECT * FROM document_deliveries WHERE document_id=? AND account_id=? ORDER BY created_at DESC',
                                 (document_id, self.account_id)).fetchall()
        return [{**{k: r[k] for k in r.keys() if k != 'issues_json'}, 'issues': json.loads(r['issues_json'])} for r in rows]

    # -------------------------------------------------------- publications
    def register_publication(self, document_id: str, params: dict) -> dict:
        """人工发布登记（C-05）：由用户声明，绑定一个已交付的冻结版本；不自动核验。"""
        version_id = params.get('version_id')
        if not isinstance(version_id, str):
            raise DocumentError('请选择已交付的版本')
        self.version(document_id, version_id, content=False)
        delivery_id = params.get('delivery_id')
        delivered = self.conn.execute('SELECT delivery_id FROM document_deliveries WHERE document_id=? AND version_id=?'
                                      ' AND account_id=? ORDER BY created_at DESC', (document_id, version_id, self.account_id)).fetchall()
        if not delivered:
            raise DocumentError('这个版本还没有复制或导出过，请先交付再登记发布')
        if delivery_id is not None and delivery_id not in {r['delivery_id'] for r in delivered}:
            raise DocumentError('交付记录与版本不一致')
        url = params.get('url', '')
        if not isinstance(url, str) or len(url) > 2000 or (url and not url.startswith(('https://', 'http://'))):
            raise DocumentError('发布链接需为 http(s) 地址，可留空')
        published_at = params.get('published_at') or now_iso()
        try:
            datetime.fromisoformat(str(published_at))
        except ValueError:
            raise DocumentError('发布时间格式无效') from None
        note = params.get('note', '')
        if not isinstance(note, str) or len(note) > 500:
            raise DocumentError('备注最多 500 字')
        record_id = new_id('pub')
        with self.store.transaction():
            self.conn.execute('INSERT INTO publication_records VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                              (record_id, self.account_id, document_id, version_id, delivery_id or delivered[0]['delivery_id'],
                               url.strip(), str(published_at), note.strip(), 'user_registered', 'active', now_iso()))
        return self.publication(record_id)

    def publication(self, record_id: str) -> dict:
        row = self.conn.execute('SELECT * FROM publication_records WHERE record_id=? AND account_id=?',
                                (record_id, self.account_id)).fetchone()
        if not row:
            raise DocumentError('发布登记不存在')
        return dict(row)

    def publications(self, document_id: str) -> list[dict]:
        rows = self.conn.execute('SELECT * FROM publication_records WHERE document_id=? AND account_id=? ORDER BY published_at DESC',
                                 (document_id, self.account_id)).fetchall()
        return [dict(r) for r in rows]

    def withdraw_publication(self, record_id: str) -> dict:
        self.publication(record_id)
        with self.store.transaction():
            self.conn.execute("UPDATE publication_records SET state='withdrawn' WHERE record_id=? AND account_id=?",
                              (record_id, self.account_id))
        return self.publication(record_id)

    @staticmethod
    def fingerprint(value: Any) -> str:
        return sha256_json(value)
