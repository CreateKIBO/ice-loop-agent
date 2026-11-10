"""v3.13 作者试用记录（开发报告 §10 第 4 项：邀请非 ICE 作者走完手动与局部 AI 链路，记录卡点与改稿成本）。

- 只有用户在界面上手动“开始记录”后才记录；随时可以停止。按公众号隔离，只存在本机数据库。
- 只记操作类型、时间和数量（例如“采纳 3/4 处”），**不记正文、提示词或模型输出**。
  标题默认不进报告，开始时勾选“报告中包含文章标题”才写入。
- 报告给出：关键旅程用时、各步骤次数、AI 局部修改采纳率、AI 初稿到交付版本的改稿比例、作者记下的卡点。
"""
from __future__ import annotations

import difflib
import json
from datetime import datetime
from typing import Any

from ..domain.types import new_id, now_iso
from .schema import DocumentError, plain_text_of

KIND_LABEL = {
    'doc_created': '新建文章', 'paste': '粘贴导入', 'import_docx': 'Word 导入', 'ai_draft': 'AI 起草（快速）',
    'ai_guided': 'AI 起草（引导）', 'assist_start': 'AI 局部修改：发起', 'assist_apply': 'AI 局部修改：采纳',
    'assist_dismiss': 'AI 局部修改：放弃', 'assist_revert': 'AI 局部修改：撤销采纳', 'delivery': '复制到公众号/纯文本',
    'export': '导出图文包', 'publication': '登记发布', 'version': '保存版本', 'friction': '卡点', 'restore': '恢复历史版本',
}
FRICTION_LIMIT = 500


def _stamp(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _minutes(start: str | None, end: str | None) -> float | None:
    a, b = _stamp(start or ''), _stamp(end or '')
    return round((b - a).total_seconds() / 60, 1) if a and b else None


def _paragraphs(content: dict) -> list[str]:
    return [text for text in (plain_text_of(node).strip() for node in content.get('doc', {}).get('content', [])) if text]


def edit_cost(before: dict, after: dict) -> dict:
    """AI 文本 → 作者交付文本的改动量：按段落对齐，统计保留段落比例与改动字数（不保存任何文字）。"""
    a, b = _paragraphs(before), _paragraphs(after)
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    kept = sum(block.size for block in matcher.get_matching_blocks())
    changed_chars = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            continue
        old, new = ''.join(a[i1:i2]), ''.join(b[j1:j2])
        if tag == 'replace':
            inner = difflib.SequenceMatcher(None, old, new, autojunk=False)
            changed_chars += sum(max(x2 - x1, y2 - y1) for t, x1, x2, y1, y2 in inner.get_opcodes() if t != 'equal')
        else:
            changed_chars += max(len(old), len(new))
    total_ai = sum(len(p) for p in a) or 1
    return {'ai_paragraphs': len(a), 'final_paragraphs': len(b), 'kept_paragraphs': kept,
            'kept_ratio': round(kept / len(a), 3) if a else None, 'ai_chars': sum(len(p) for p in a),
            'final_chars': sum(len(p) for p in b), 'changed_chars': changed_chars,
            'changed_ratio': round(min(1.0, changed_chars / total_ai), 3)}


class TrialLog:
    def __init__(self, store: Any, account: dict):
        self.store = store
        self.account = account

    def _ready(self) -> bool:
        return bool(self.store.conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trial_sessions'").fetchone())

    def active(self) -> dict | None:
        if not self._ready():
            return None
        row = self.store.conn.execute('SELECT * FROM trial_sessions WHERE account_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
                                      (self.account['id'],)).fetchone()
        return dict(row) if row else None

    def record(self, kind: str, document_id: str | None = None, /, **payload: Any) -> None:
        """记一条事件；没有进行中的试用时什么都不做。payload 只允许数字、布尔和短标识。"""
        session = self.active()
        if not session or kind not in KIND_LABEL:
            return
        clean = {k: v for k, v in payload.items() if isinstance(v, (int, float, bool)) or (isinstance(v, str) and len(v) <= 40)}
        with self.store.transaction():
            self.store.conn.execute('INSERT INTO trial_events (event_id, session_id, account_id, kind, document_id, payload_json, created_at)'
                                    ' VALUES (?,?,?,?,?,?,?)', (new_id('tev'), session['session_id'], self.account['id'], kind,
                                                                document_id, json.dumps(clean, ensure_ascii=False), now_iso()))

    # --------------------------------------------------------------- RPC
    def start(self, params: dict) -> dict:
        if not self._ready():
            raise DocumentError('数据库尚未升级，请重启应用后再试')
        if self.active():
            raise DocumentError('已有进行中的试用记录，请先结束')
        label = params.get('label') or ''
        if not isinstance(label, str) or len(label) > 60:
            raise DocumentError('试用名称最多 60 字')
        with self.store.transaction():
            self.store.conn.execute('INSERT INTO trial_sessions (session_id, account_id, label, include_titles, started_at) VALUES (?,?,?,?,?)',
                                    (new_id('trial'), self.account['id'], label.strip(), 1 if params.get('include_titles') is True else 0,
                                     now_iso()))
        return self.status({})

    def stop(self, params: dict) -> dict:
        session = self.active()
        if not session:
            raise DocumentError('没有进行中的试用记录')
        with self.store.transaction():
            self.store.conn.execute('UPDATE trial_sessions SET ended_at=? WHERE session_id=?', (now_iso(), session['session_id']))
        return {'session_id': session['session_id'], **self.status({})}

    def note(self, params: dict) -> dict:
        text = params.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > FRICTION_LIMIT:
            raise DocumentError(f'卡点说明需为 1–{FRICTION_LIMIT} 字')
        where = params.get('where') or ''
        if not isinstance(where, str) or len(where) > 40:
            raise DocumentError('位置标识无效')
        session = self.active()
        if not session:
            raise DocumentError('请先开始试用记录')
        document_id = params.get('document_id') if isinstance(params.get('document_id'), str) else None
        with self.store.transaction():
            self.store.conn.execute('INSERT INTO trial_events (event_id, session_id, account_id, kind, document_id, payload_json, created_at)'
                                    ' VALUES (?,?,?,?,?,?,?)', (new_id('tev'), session['session_id'], self.account['id'], 'friction',
                                                                document_id, json.dumps({'text': text.strip(), 'where': where},
                                                                                        ensure_ascii=False), now_iso()))
        return self.status({})

    def status(self, params: dict) -> dict:
        session = self.active()
        sessions = []
        if self._ready():
            sessions = [dict(r) for r in self.store.conn.execute(
                'SELECT s.*, (SELECT COUNT(*) FROM trial_events e WHERE e.session_id=s.session_id) AS events'
                ' FROM trial_sessions s WHERE s.account_id=? ORDER BY s.started_at DESC LIMIT 10', (self.account['id'],))]
        count = next((s['events'] for s in sessions if session and s['session_id'] == session['session_id']), 0)
        return {'active': session, 'events': count, 'sessions': sessions}

    def report(self, params: dict) -> dict:
        session_id = params.get('session_id')
        if session_id:
            row = self.store.conn.execute('SELECT * FROM trial_sessions WHERE session_id=? AND account_id=?',
                                          (session_id, self.account['id'])).fetchone()
        else:
            row = self.store.conn.execute('SELECT * FROM trial_sessions WHERE account_id=? ORDER BY started_at DESC LIMIT 1',
                                          (self.account['id'],)).fetchone() if self._ready() else None
        if not row:
            raise DocumentError('还没有试用记录')
        session = dict(row)
        events = [dict(r) | {'payload': json.loads(r['payload_json'] or '{}')} for r in self.store.conn.execute(
            'SELECT * FROM trial_events WHERE session_id=? ORDER BY created_at, rowid', (session['session_id'],))]
        end = session['ended_at'] or now_iso()
        counts: dict[str, int] = {}
        for event in events:
            counts[event['kind']] = counts.get(event['kind'], 0) + 1

        def first(*kinds: str) -> str | None:
            return next((e['created_at'] for e in events if e['kind'] in kinds), None)
        journey = {
            '开始 → 第一篇文章': _minutes(session['started_at'], first('doc_created', 'paste', 'import_docx', 'ai_draft', 'ai_guided')),
            '开始 → 第一次交付（复制/导出）': _minutes(session['started_at'], first('delivery', 'export')),
            '开始 → 登记发布': _minutes(session['started_at'], first('publication')),
            '试用总时长': _minutes(session['started_at'], end),
        }
        applies = [e['payload'] for e in events if e['kind'] == 'assist_apply']
        accepted = sum(int(p.get('accepted', 0)) for p in applies)
        offered = sum(int(p.get('total', 0)) for p in applies)
        assist = {'发起': counts.get('assist_start', 0), '采纳': len(applies), '放弃': counts.get('assist_dismiss', 0),
                  '撤销': counts.get('assist_revert', 0),
                  '采纳处数/提议处数': f'{accepted}/{offered}' if offered else '—'}
        costs = self._edit_costs(events)
        include_titles = bool(session['include_titles'])
        titles: dict[str, str] = {}
        if include_titles:
            ids = {e['document_id'] for e in events if e['document_id']} | {c['document_id'] for c in costs}
            for document_id in ids:
                found = self.store.conn.execute('SELECT title FROM documents WHERE document_id=? AND account_id=?',
                                                (document_id, self.account['id'])).fetchone()
                if found:
                    titles[document_id] = found['title']
        frictions = [{'at': e['created_at'], 'where': e['payload'].get('where', ''), 'text': e['payload'].get('text', ''),
                      'document': titles.get(e['document_id'] or '', '')} for e in events if e['kind'] == 'friction']
        name = session['label'] or '作者试用'
        lines = [f'# 作者试用报告：{name}', '',
                 f'- 时间：{session["started_at"]} → {session["ended_at"] or "（仍在记录）"}',
                 '- 只记录操作类型、时间和数量，不含正文、提示词或模型输出' + ('；标题已按试用设置包含。' if include_titles else '；不含文章标题。'), '',
                 '## 关键旅程（分钟）', '', '| 节点 | 用时 |', '|---|---|']
        lines += [f'| {k} | {"—" if v is None else v} |' for k, v in journey.items()]
        lines += ['', '## 各步骤次数', '', '| 步骤 | 次数 |', '|---|---|']
        lines += [f'| {KIND_LABEL[k]} | {v} |' for k, v in sorted(counts.items(), key=lambda kv: list(KIND_LABEL).index(kv[0]))]
        lines += ['', '## AI 局部修改', '', '| 项 | 值 |', '|---|---|'] + [f'| {k} | {v} |' for k, v in assist.items()]
        lines += ['', '## AI 初稿 → 交付版本的改稿量', '']
        if costs:
            lines += ['| 文章 | AI 段落 | 保留段落 | 改动字数 / AI 字数 | 改稿比例 | 对照版本 |', '|---|---|---|---|---|---|']
            for index, cost in enumerate(costs, start=1):
                label = titles.get(cost['document_id']) or f'文章 {index}'
                lines.append(f'| {label} | {cost["ai_paragraphs"]} | {cost["kept_paragraphs"]} | {cost["changed_chars"]} / {cost["ai_chars"]}'
                             f' | {round(cost["changed_ratio"] * 100)}% | {cost["compared_to"]} |')
            lines.append('')
            lines.append('改稿比例 = 作者相对 AI 文本改动的字数 ÷ AI 文本字数（上限 100%）；按段落对齐，只统计数量，不保存文字。')
        else:
            lines.append('本次试用没有 AI 初稿进入交付或保存版本。')
        lines += ['', '## 作者记下的卡点', '']
        if frictions:
            for item in frictions:
                where = f'［{item["where"]}］' if item['where'] else ''
                doc = f'（{item["document"]}）' if item['document'] else ''
                lines.append(f'- {item["at"][11:16]} {where}{doc}{item["text"]}')
        else:
            lines.append('（没有记录）')
        lines += ['', '> 报告由应用在本机生成。是否分享、分享给谁由作者决定。']
        return {'markdown': '\n'.join(lines) + '\n', 'session': session, 'counts': counts, 'journey': journey,
                'assist': assist, 'edit_costs': costs, 'frictions': len(frictions)}

    def _edit_costs(self, events: list[dict]) -> list[dict]:
        """对本次试用中出现过的 AI 初稿：AI 生成的版本 vs 最近一次交付（或最新版本/工作副本）。"""
        ids = list(dict.fromkeys(e['document_id'] for e in events
                                 if e['document_id'] and e['kind'] in ('ai_draft', 'assist_apply', 'delivery', 'export', 'publication')))
        out = []
        for document_id in ids:
            versions = [dict(r) for r in self.store.conn.execute(
                'SELECT version_id, producer, content_json, created_at FROM document_versions WHERE document_id=? AND account_id=?'
                ' ORDER BY created_at, rowid', (document_id, self.account['id']))]
            ai = next((v for v in versions if v['producer'] == 'ai'), None)
            if not ai:
                continue
            delivered = self.store.conn.execute(
                'SELECT v.content_json FROM document_deliveries d JOIN document_versions v ON v.version_id=d.version_id'
                ' WHERE d.document_id=? AND d.account_id=? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1',
                (document_id, self.account['id'])).fetchone()
            if delivered:
                final, compared = json.loads(delivered['content_json']), '最近一次交付'
            else:
                working = self.store.conn.execute('SELECT content_json FROM document_working WHERE document_id=?', (document_id,)).fetchone()
                if not working:
                    continue
                final, compared = json.loads(working['content_json']), '当前稿（尚未交付）'
            out.append({'document_id': document_id, 'compared_to': compared, **edit_cost(json.loads(ai['content_json']), final)})
        return out
