"""Desktop-owned output context, separate from model/legacy article inputs.

The existing append-only job event stream is the admission receipt. It is not
supplied through an RPC parameter, an article spec or an account snapshot. This
does not attempt to protect a database from somebody editing it directly.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from ..domain.types import sha256_json
from ..paths import assert_not_c_drive, assert_within, normalize

EVENT = 'job.desktop_context'
RELOCATION_EVENT = 'job.desktop_context_relocated'


def _receipt(store, job_id):
    row = store.conn.execute(
        "SELECT payload FROM events WHERE job_id=? AND event_type IN (?,?) ORDER BY sequence DESC LIMIT 1",
        (job_id, EVENT, RELOCATION_EVENT)).fetchone()
    if row is None:
        return None
    data = json.loads(row[0])
    if (not isinstance(data, dict) or data.get('version') != 1
            or not isinstance(data.get('account_id'), str)
            or not isinstance(data.get('article_root'), str)
            or not Path(data['article_root']).is_absolute()
            or type(data.get('allow_demo_exec')) is not bool):
        raise ValueError('任务运行上下文记录无效，请从备份恢复后重试')
    assert_not_c_drive(data['article_root'])
    return data


def record_context(store, job_id, account_id, article_root, *, allow_demo_exec=False,
                   source='desktop_create'):
    """Called inside create_job's transaction, using server-selected arguments."""
    root = normalize(article_root)
    assert_not_c_drive(root)
    data = {'version': 1, 'account_id': account_id, 'article_root': str(root),
            'allow_demo_exec': bool(allow_demo_exec), 'source': source}
    previous = _receipt(store, job_id)
    if previous is not None:
        if previous != data:
            raise ValueError('任务已有不同的运行上下文，不能重复绑定')
        return previous
    store.append_event(job_id, EVENT, data)
    return data


def _metadata(service, store, job_id, expected_owner, background):
    job = store.get_job(job_id)
    if job is None:
        raise KeyError('任务不存在')
    article = store.get_article(job['article_id'])
    receipt = _receipt(store, job_id)
    binding = store.conn.execute(
        "SELECT account_id FROM task_job_bindings WHERE job_id=?", (job_id,)).fetchone()
    owner = (receipt['account_id'] if receipt else binding[0] if binding
             else article['spec'].get('account_id') or 'ice-loop')
    if ((expected_owner is not None and owner != expected_owner)
            or binding and binding[0] != owner
            or article['spec'].get('account_id') not in (None, owner)):
        raise ValueError('绑定文章与任务归属不一致')
    if not background and owner != service._account()['id']:
        raise ValueError('当前公众号没有该任务，请刷新任务列表')
    account = service._account(owner)
    return job, article, receipt, owner, account


def desktop_context(service, store, job_id, *, expected_owner=None, background=False):
    """Admit an old job once, atomically retaining revisions and hash approvals.

    Historical files are neither moved nor removed. Without an admission record,
    future output uses the owner's currently configured root. A valid code/input
    approval survives; a bare legacy boolean is never converted into approval.
    """
    job, article, receipt, owner, account = _metadata(service,store,job_id,expected_owner,background)
    if (receipt and article['spec'].get('account_id') == owner
            and article['spec'].get('article_root') == receipt['article_root']
            and (not article['spec'].get('approve_local_exec')
                 or receipt['allow_demo_exec'] and article['spec'].get('demo') is True)):
        # Already-admitted polls need neither a SQLite write lock nor another
        # full-body checkpoint decode. The engine verifies its checkpoint hash.
        return receipt
    with store.transaction():
        # Re-read after acquiring the write lock: another request may already
        # have admitted this job. The whole upgrade remains idempotent.
        job, article, receipt, owner, account = _metadata(service,store,job_id,expected_owner,background)
        state = store.load_checkpoint(job_id)
        if state is None:
            file = service.runtime/'jobs'/job_id/'state.json'
            assert_within(file, service.runtime/'jobs')
            if not file.is_file():
                raise ValueError('任务检查点不存在，请从备份恢复后重试')
            state = json.loads(file.read_text(encoding='utf-8'))
        if not isinstance(state, dict) or not isinstance(state.get('spec'), dict):
            raise ValueError('任务检查点格式无效，请从备份恢复后重试')
        if state['spec'].get('account_id') not in (None, owner):
            raise ValueError('任务检查点与公众号归属不一致')

        old = receipt is None
        root = (receipt['article_root'] if receipt else str(normalize(
            Path(account['article_root'])/('补图候选' if article['spec'].get('image_only') else ''))))
        allow_demo = bool(receipt and receipt['allow_demo_exec'] and article['spec'].get('demo') is True)
        article_spec = copy.deepcopy(article['spec'])
        state_spec = copy.deepcopy(state['spec'])
        for spec in (article_spec, state_spec):
            spec.update(account_id=owner, article_root=root)
            if not allow_demo:
                spec['approve_local_exec'] = False
        if old and not state_spec.get('image_only'):
            from ..execution.plan import execution_hash
            # Preserve an authentic approval's exact execution environment. For
            # an unreviewed old payload, use the current server-owned policy.
            if state.get('execution_approval') != execution_hash(state):
                policy = service.settings.get('execution', {'mode': 'local_reviewed',
                    'images': {'python': 'python:3.12-slim', 'java': 'eclipse-temurin:17-jdk'}})
                for spec in (article_spec, state_spec):
                    spec.update(execution_mode=policy['mode'], container_images=copy.deepcopy(policy['images']))
        changed = article_spec != article['spec'] or state_spec != state['spec']
        if (old or changed) and job.get('lease'):
            raise ValueError('旧任务正在运行，请先暂停，等待停止后再恢复')
        if changed:
            fields = sorted(key for key in set(article_spec)|set(state_spec)
                if article['spec'].get(key) != article_spec.get(key) or state['spec'].get(key) != state_spec.get(key))
            store.conn.execute("UPDATE articles SET spec_json=? WHERE article_id=?",
                (json.dumps(article_spec, ensure_ascii=False), article['article_id']))
            state['spec'] = state_spec
            store.save_checkpoint(job_id, state, commit=False)
            store.append_event(job_id, 'job.context_upgraded', {'fields': fields,
                'source': 'legacy_desktop' if old else 'context_reconcile',
                'previous_spec_hash': sha256_json(article['spec']),
                'note': '未来输出使用已确认的公众号目录；旧文件保留；代码须按当前内容审阅'})
        elif old:
            # Upgrade a file-only checkpoint to the authoritative database too.
            store.save_checkpoint(job_id, state, commit=False)
        if old:
            receipt = record_context(store, job_id, owner, root, source='legacy_upgrade')
        return receipt
