"""Bounded completed-article resume audit in a freshly seeded owned fixture.

SQL connections are read-only; the sole attempted mutation is the real refused
jobs.resume RPC. Never fabricate queue bindings or RESTORE_REVIEW markers.
Run tests/seed_reading_upgrade_native.py first; no personal runtime argument.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from uuid import uuid4

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from ice_agent.desktop_service import DesktopService


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def identity(detail):
    job, article = detail['job'], detail['article']
    return {
        'job': job['job_id'], 'article': article['article_id'],
        'account': article['spec']['account_id'], 'state': job['state'],
        'node': job['current_node'], 'lease': job['lease'], 'stopping': job['stopping'],
        'updated_at': job['updated_at'], 'body_hash': detail['body_hash'],
        'slots': [[s['slot_id'], s['content_hash'], s['valid']] for s in detail['slots']],
        'events': len(detail['events']), 'events_hash': digest(detail['events']),
        'invocations': len(detail['invocations']), 'invocations_hash': digest(detail['invocations']),
        'pending_hash': digest(detail['pending_approval']),
    }


def read_queue(database, job_id):
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as db:
        summary = {
            'tasks': db.execute('SELECT count(*) FROM tasks').fetchone()[0],
            'bindings': db.execute('SELECT count(*) FROM task_job_bindings WHERE job_id=?', (job_id,)).fetchone()[0],
            'restore_review': db.execute("SELECT count(*) FROM tasks WHERE error_code='RESTORE_REVIEW'").fetchone()[0],
            'paused': db.execute("SELECT count(*) FROM tasks WHERE state='paused'").fetchone()[0],
        }
        summary['total_changes'] = db.total_changes
        assert summary['total_changes'] == 0
        return summary


def main():
    fixture = json.loads((REPO / 'docs/上线准备/reading-upgrade-fixture.json').read_text())
    root, runtime = Path(fixture['root']).resolve(), Path(fixture['runtime']).resolve()
    assert root.parent == REPO / '.test-tmp/release-interaction-lists'
    assert (root / '.test-owner.json').is_file() and runtime == root / 'runtime'
    params = {'account_id': fixture['account_a'], 'job_id': fixture['jobs']['completed']}
    service = DesktopService(REPO, runtime, root / 'articles', auto_consumer=False)
    try:
        # Desktop context may be upgraded on the first jobs.get. Establish the
        # baseline after that read, exactly as the already-open workspace does.
        before = identity(service.call('jobs.get', params))
        assert before['job'] == params['job_id'] and before['account'] == params['account_id']
        assert before['state'] == 'completed' and before['node'] == 'export'
        assert not before['lease'] and not before['stopping'] and before['slots']
        queue_before = read_queue(runtime / 'app.db', params['job_id'])
        assert all(queue_before[key] == 0 for key in queue_before), 'Refuse a non-empty recovery fixture'
        restored = service.call('backup.queue', {'account_id': params['account_id']})
        assert restored['total'] == 0
        rejection = None
        try:
            service.call('jobs.resume', params)
        except ValueError as error:
            rejection = str(error)
        assert rejection == '该任务不能继续', 'Completed resume did not meet the expected refusal boundary'
        after = identity(service.call('jobs.get', params))
        queue_after = read_queue(runtime / 'app.db', params['job_id'])
        assert before == after and queue_before == queue_after
        named_running = service.call('jobs.get', {'account_id': params['account_id'], 'job_id': fixture['jobs']['running']})
        report = {
            'scope': 'owned completed/export fixture; ro SQL + real refused resume RPC; no consumer or model',
            'before': before, 'after': after, 'queue_before': queue_before, 'queue_after': queue_after,
            'backup_queue_total': restored['total'], 'rejection': rejection,
            'named_running_actual_state': named_running['job']['state'],
            'electron': {
                'project': (REPO / 'desktop/node_modules/electron').exists(),
                'git_root': (REPO.parent / 'desktop/node_modules/electron').exists(),
                'executable': shutil.which('electron'),
            },
        }
    finally:
        service.close()
    output = root / ('resume-entry-audit-' + uuid4().hex[:12] + '.json')
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'evidence': str(output), **report}, ensure_ascii=False))


if __name__ == '__main__':
    main()
