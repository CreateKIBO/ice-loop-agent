"""Immutable article history, optimistic edits and non-destructive restore."""
import difflib
import json

from .domain.types import new_id, now_iso, sha256_text
from .workflow.nodes import evidence_errors

BODY_KINDS = ('draft', 'integrated', 'manual', 'restore', 'before_edit', 'final')


def history(store, article_id):
    rows = store.conn.execute('SELECT * FROM article_revisions WHERE article_id=? ORDER BY rowid DESC', (article_id,))
    return [dict(row) for row in rows if row['kind'] in BODY_KINDS and row['content'].lstrip().startswith('# ')]


def get_revision(store, article_id, revision_id):
    revision = next((row for row in history(store, article_id) if row['revision_id'] == revision_id), None)
    if not revision or sha256_text(revision['content']) != revision['content_hash']:
        raise ValueError('版本不存在、属于其他文章或已损坏')
    return revision


def compare(before, after):
    return '\n'.join(difflib.unified_diff(before.splitlines(), after.splitlines(),
                                         fromfile='历史版本', tofile='当前正文', lineterm=''))


def save_body(engine, store, job_id, text, expected_hash, account_id, restore_id=None, *, protect_editor_draft=False):
    if not isinstance(text, str) or not 1 <= len(text) <= 100000:
        raise ValueError('正文不能为空或超过长度上限')
    with store.transaction():
        job = store.get_job(job_id)
        article = store.get_article(job['article_id'])
        if article['spec'].get('image_only'):
            raise ValueError('补图任务的原稿保持只读，不能保存或恢复正文')
        if article['spec'].get('account_id', 'ice-loop') != account_id:
            raise ValueError('只能编辑当前公众号的文章')
        if job['lease'] or not (job['state'] == 'completed' or
                job['state'] == 'failed' and job['current_node'] in ('article_review', 'style_review')):
            raise ValueError('请等待写作和审核完成后编辑正文')
        state = engine._load_state(job_id)
        previous = state.get('integrated_md', '')
        if sha256_text(previous) != expected_hash:
            raise ValueError('正文已变化，请先刷新并保留本地修改')
        if protect_editor_draft:
            # Check under the same write lock as the body update, including another window's autosave.
            draft = store.conn.execute(
                'SELECT content FROM editor_drafts WHERE account_id=? AND article_id=?',
                (account_id, job['article_id'])).fetchone()
            if draft is not None and draft['content'] != previous:
                raise ValueError('存在尚未保存为正文版本的工作草稿，请先恢复并保存，或明确丢弃后再应用提案；两份草稿均保留')
        if restore_id:
            text = get_revision(store, job['article_id'], restore_id)['content']
        revision_id, previous_id = new_id('rev'), new_id('rev')
        for rid, kind, body, parent in [(previous_id, 'before_edit', previous, None),
                (revision_id, 'restore' if restore_id else 'manual', text, restore_id or previous_id)]:
            store.conn.execute('INSERT INTO article_revisions VALUES (?,?,?,?,?,?,?,?)',
                (rid, job['article_id'], kind, body, sha256_text(body), parent, 'desktop-user', now_iso()))
        state['integrated_md'] = text
        state.pop('final_check_report', None)
        state['body_revision_id'] = revision_id
        # Preserve old evidence and approvals, but never inherit publication readiness.
        store.save_checkpoint(job_id, state, commit=False)
        store.conn.execute("UPDATE articles SET readiness='review_pending' WHERE article_id=?", (job['article_id'],))
        if protect_editor_draft:
            # Only retire a recovery copy matching the old body. A new draft after commit survives.
            store.conn.execute('DELETE FROM editor_drafts WHERE account_id=? AND article_id=? AND content=?',
                               (account_id, job['article_id'], previous))
    engine._write_state_file(job_id, state)
    store.append_event(job_id, 'article.restored' if restore_id else 'article.edited',
                       {'revision_id': revision_id, 'parent_revision': restore_id or previous_id})
    return {'revision_id': revision_id, 'content_hash': sha256_text(text),
            'evidence_errors': evidence_errors(text, state.get('runs', {}))}
