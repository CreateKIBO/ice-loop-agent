"""P2 运营增强：批量整理、发布日历（计划日期 + 发布登记）、跨文章建议管理、素材标签。

全部按当前公众号隔离；不改变正文内容，不自动发布。
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any

from ..domain.types import now_iso
from .schema import DocumentError
from .store import DocumentStore

MAX_BATCH = 200
MAX_TAGS, TAG_LIMIT = 10, 20
BATCH_ACTIONS = ('trash', 'untrash', 'set_series', 'clear_series', 'set_planned', 'clear_planned')


def _date(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise DocumentError('日期格式应为 YYYY-MM-DD')
    try:
        date.fromisoformat(value)
    except ValueError:
        raise DocumentError('日期无效') from None
    return value


class DocumentOps:
    def __init__(self, service: Any, store: Any, account: dict):
        self.service = service
        self.store = store
        self.account = account
        self.docs = DocumentStore(store, account['id'])
        from ..workspace_assets import WorkspaceAssets
        self.assets = WorkspaceAssets(store, service.runtime, account['id'])

    # ---------------------------------------------------------------- meta
    def _set_meta(self, document_id: str, **values: Any) -> None:
        row = self.store.conn.execute('SELECT meta_json FROM documents WHERE document_id=? AND account_id=?',
                                      (document_id, self.account['id'])).fetchone()
        meta = json.loads(row['meta_json'] or '{}')
        for key, value in values.items():
            if value is None:
                meta.pop(key, None)
            else:
                meta[key] = value
        self.store.conn.execute('UPDATE documents SET meta_json=?, updated_at=? WHERE document_id=?',
                                (json.dumps(meta, ensure_ascii=False), now_iso(), document_id))

    def plan(self, params: dict) -> dict:
        """设置/清除计划发布日期（只用于日历排期，不触发任何发布）。"""
        document_id = params.get('document_id', '')
        self.docs._row(document_id)
        planned = params.get('planned_date')
        with self.store.transaction():
            self._set_meta(document_id, planned_date=_date(planned) if planned else None)
        return self.docs.get(document_id)

    # --------------------------------------------------------------- batch
    def batch(self, params: dict) -> dict:
        """批量整理：一个事务内全部成功或全部不改。"""
        action = params.get('action')
        if action not in BATCH_ACTIONS:
            raise DocumentError('不支持的批量操作')
        ids = params.get('document_ids')
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise DocumentError('请先勾选文章')
        ids = list(dict.fromkeys(ids))
        if len(ids) > MAX_BATCH:
            raise DocumentError(f'一次最多处理 {MAX_BATCH} 篇')
        series = params.get('series')
        planned = params.get('planned_date')
        if action == 'set_series' and (not isinstance(series, str) or not series.strip() or len(series.strip()) > 40):
            raise DocumentError('请输入 1–40 字的系列名')
        if action == 'set_planned':
            planned = _date(planned)
        changed = []
        with self.store.transaction():
            for document_id in ids:
                document = self.docs._row(document_id)  # 不属于当前公众号的整批拒绝
                if action in ('trash', 'untrash'):
                    target = 'trashed' if action == 'trash' else 'active'
                    if document['lifecycle'] == target:
                        continue
                    if action == 'trash' and document['generation_state'] == 'running':
                        raise DocumentError(f'「{document["title"]}」还在生成，不能移入回收站')
                    self.docs.set_lifecycle(document_id, target)
                elif action == 'set_series':
                    self.store.conn.execute('UPDATE documents SET series=?, updated_at=? WHERE document_id=?',
                                            (series.strip(), now_iso(), document_id))
                elif action == 'clear_series':
                    self.store.conn.execute('UPDATE documents SET series=NULL, episode=NULL, updated_at=? WHERE document_id=?',
                                            (now_iso(), document_id))
                elif action == 'set_planned':
                    self._set_meta(document_id, planned_date=planned)
                elif action == 'clear_planned':
                    self._set_meta(document_id, planned_date=None)
                changed.append(document_id)
        return {'action': action, 'changed': changed, 'skipped': [i for i in ids if i not in changed]}

    # ------------------------------------------------------------ calendar
    def calendar(self, params: dict) -> dict:
        """某月的发布日历：已登记发布（按发布时间）与计划日期（按 meta.planned_date）。"""
        month = params.get('month')
        if not isinstance(month, str) or not re.fullmatch(r'\d{4}-\d{2}', month):
            raise DocumentError('月份格式应为 YYYY-MM')
        year, mon = (int(x) for x in month.split('-'))
        if not 1 <= mon <= 12:
            raise DocumentError('月份无效')
        published = []
        for row in self.store.conn.execute(
                "SELECT p.record_id, p.document_id, p.version_id, p.url, p.published_at, p.note, d.title, d.lifecycle"
                " FROM publication_records p JOIN documents d ON d.document_id=p.document_id"
                " WHERE p.account_id=? AND p.state='active' ORDER BY p.published_at", (self.account['id'],)):
            try:
                day = datetime.fromisoformat(row['published_at']).date()
            except ValueError:
                continue
            if (day.year, day.month) == (year, mon):
                published.append({'kind': 'published', 'date': day.isoformat(), **{k: row[k] for k in (
                    'record_id', 'document_id', 'version_id', 'url', 'note', 'title', 'lifecycle')},
                    'published_at': row['published_at']})
        planned = []
        published_docs = {p['document_id'] for p in published}
        for row in self.store.conn.execute("SELECT document_id, title, series, episode, meta_json FROM documents"
                                           " WHERE account_id=? AND lifecycle='active'", (self.account['id'],)):
            meta = json.loads(row['meta_json'] or '{}')
            when = meta.get('planned_date')
            if isinstance(when, str) and when.startswith(month):
                planned.append({'kind': 'planned', 'date': when, 'document_id': row['document_id'], 'title': row['title'],
                                'series': row['series'], 'episode': row['episode'],
                                'published': row['document_id'] in published_docs})
        planned.sort(key=lambda item: (item['date'], item['title']))
        unplanned = self.store.conn.execute(
            "SELECT COUNT(*) FROM documents d WHERE d.account_id=? AND d.lifecycle='active'"
            " AND json_extract(d.meta_json, '$.planned_date') IS NULL"
            " AND NOT EXISTS(SELECT 1 FROM publication_records p WHERE p.document_id=d.document_id AND p.state='active')",
            (self.account['id'],)).fetchone()[0]
        return {'month': month, 'published': published, 'planned': planned, 'unplanned_count': unplanned}

    # ------------------------------------------------------- suggestions
    def suggestions(self, params: dict) -> dict:
        """跨文章的 AI 修改提案：待采纳、生成中、失败；附文章标题与过期数，便于集中处理。"""
        if not self.store.conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_proposals'").fetchone():
            return {'items': [], 'counts': {}}
        from .assist import DocumentAssist
        assist = DocumentAssist(self.service, self.store, self.account)
        rows = self.store.conn.execute(
            "SELECT p.proposal_id, p.document_id, d.title FROM document_proposals p JOIN documents d ON d.document_id=p.document_id"
            " WHERE p.account_id=? AND d.lifecycle='active' AND p.status IN ('generating','ready','failed')"
            " ORDER BY p.created_at DESC LIMIT 100", (self.account['id'],)).fetchall()
        reconciled = set()
        items = []
        for row in rows:
            if row['document_id'] not in reconciled:
                assist._reconcile(row['document_id'])
                reconciled.add(row['document_id'])
            proposal = assist.get({'proposal_id': row['proposal_id']})
            if proposal['status'] not in ('generating', 'ready', 'failed'):
                continue
            items.append({'proposal_id': proposal['proposal_id'], 'document_id': row['document_id'], 'title': row['title'],
                          'action': proposal['action'], 'action_label': proposal['action_label'], 'status': proposal['status'],
                          'ops': len(proposal['ops']), 'stale': proposal['stale_count'], 'notes': proposal['notes'][:120],
                          'error': proposal['error'], 'created_at': proposal['created_at'], 'instruction': proposal['instruction']})
        counts: dict[str, int] = {}
        for item in items:
            counts[item['status']] = counts.get(item['status'], 0) + 1
        return {'items': items, 'counts': counts}

    def dismiss_suggestions(self, params: dict) -> dict:
        """批量放弃待采纳/失败的提案（不改正文）。"""
        ids = params.get('proposal_ids')
        if not isinstance(ids, list) or not ids or len(ids) > 100 or not all(isinstance(i, str) for i in ids):
            raise DocumentError('请先选择要放弃的建议')
        with self.store.transaction():
            for pid in ids:
                row = self.store.conn.execute('SELECT status, ops_json FROM document_proposals WHERE proposal_id=? AND account_id=?',
                                              (pid, self.account['id'])).fetchone()
                if not row:
                    raise DocumentError('有建议不属于当前公众号')
                if row['status'] not in ('ready', 'failed'):
                    continue
                rejected = [op['op_id'] for op in json.loads(row['ops_json'] or '[]')]
                self.store.conn.execute("UPDATE document_proposals SET status='rejected', decision_json=?, decided_at=? WHERE proposal_id=?",
                                        (json.dumps({'accepted': [], 'rejected': rejected, 'bulk': True}), now_iso(), pid))
        return self.suggestions({})

    # -------------------------------------------------------------- assets
    def library(self, params: dict) -> dict:
        """素材库：按标签/名称筛选当前公众号的图片资源，附全部标签及计数。"""
        query = str(params.get('query') or '').strip().casefold()[:100]
        tag = params.get('tag') or ''
        offset = params.get('offset', 0)
        limit = params.get('limit', 40)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise DocumentError('分页参数无效')
        rows = [r for r in self.assets.resources() if str(r.get('mime', '')).startswith('image/')]
        tags: dict[str, int] = {}
        for resource in rows:
            for item in resource.get('tags') or []:
                tags[item] = tags.get(item, 0) + 1
        matched = []
        for resource in rows:
            labels = resource.get('tags') or []
            if tag and tag not in labels:
                continue
            haystack = ' '.join([str(resource.get('title', ''))] + labels +
                                [str((resource.get('document_source') or {}).get('original_name', ''))]).casefold()
            if query and query not in haystack:
                continue
            matched.append(resource)
        page = matched[offset:offset + limit]
        return {'items': [{'resource_id': r['resource_id'], 'title': r.get('title', ''), 'width': r.get('width'),
                           'height': r.get('height'), 'mime': r.get('mime'), 'size': r.get('size'), 'tags': r.get('tags') or [],
                           'source_kind': (r.get('document_source') or {}).get('kind', 'library')} for r in page],
                'total': len(matched), 'offset': offset,
                'tags': [{'tag': k, 'count': v} for k, v in sorted(tags.items(), key=lambda kv: (-kv[1], kv[0]))]}

    def tag(self, params: dict) -> dict:
        tags = params.get('tags')
        if not isinstance(tags, list) or len(tags) > MAX_TAGS or not all(isinstance(t, str) for t in tags):
            raise DocumentError(f'每张图最多 {MAX_TAGS} 个标签')
        clean = []
        for item in tags:
            value = re.sub(r'\s+', ' ', item).strip().lstrip('#')
            if not value:
                continue
            if len(value) > TAG_LIMIT:
                raise DocumentError(f'标签最多 {TAG_LIMIT} 字')
            if value not in clean:
                clean.append(value)
        ids = params.get('resource_ids') or [params.get('resource_id')]
        if not isinstance(ids, list) or not ids or len(ids) > MAX_BATCH:
            raise DocumentError('请选择图片')
        mode = params.get('mode', 'replace')
        if mode not in ('replace', 'add', 'remove'):
            raise DocumentError('标签操作无效')
        resources = [self.assets.resource(str(i)) for i in ids]
        for resource in resources:
            current = list(resource.get('tags') or [])
            if mode == 'replace':
                current = clean
            elif mode == 'add':
                current = current + [t for t in clean if t not in current]
            else:
                current = [t for t in current if t not in clean]
            if len(current) > MAX_TAGS:
                raise DocumentError(f'「{resource.get("title") or "图片"}」的标签会超过 {MAX_TAGS} 个')
            resource['tags'] = current
        for resource in resources:
            self.assets.save_resource(resource)
        return {'updated': [r['resource_id'] for r in resources], 'tags': resources[0]['tags'] if len(resources) == 1 else clean}
