"""Owned empty streaming message for renderer feedback; no live consumer/model."""
import json
import runpy
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
runpy.run_path(str(repo / 'tests/seed_reading_upgrade_native.py'))
fixture = json.loads((repo / 'docs/上线准备/reading-upgrade-fixture.json').read_text())
root, runtime = Path(fixture['root']), Path(fixture['runtime'])
assert root.parent == repo / '.test-tmp/release-interaction-lists'
assert (root / '.test-owner.json').is_file() and runtime == root / 'runtime'
now = datetime.now(timezone.utc).isoformat()
with closing(sqlite3.connect(runtime / 'app.db')) as db:
    conversation = fixture['conversations'][0]
    assert db.execute('SELECT count(*) FROM creative_messages WHERE conversation_id=?', (conversation,)).fetchone()[0] == 0
    db.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
               ('reading-wait-stream', conversation, 'assistant', '', 'streaming',
                json.dumps({'progress': {'phase': 'waiting_model', 'started_at': now}}), now))
    db.commit()
print(json.dumps({'empty_streaming_messages': 1, 'runtime': str(runtime)}))
