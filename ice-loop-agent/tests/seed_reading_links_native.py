"""Owned synthetic reading messages with an offscreen keyboard link; no model."""
import json
import runpy
import sqlite3
from contextlib import closing
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
runpy.run_path(str(repo / 'tests/seed_reading_motion_native.py'))
fixture = json.loads((repo / 'docs/上线准备/reading-upgrade-fixture.json').read_text())
root, runtime = Path(fixture['root']), Path(fixture['runtime'])
assert root.parent == repo / '.test-tmp/release-interaction-lists'
assert (root / '.test-owner.json').is_file() and runtime == root / 'runtime'
with closing(sqlite3.connect(runtime / 'app.db')) as db:
    changed = db.execute('UPDATE creative_messages SET content=? || content WHERE id=? AND conversation_id=?',
                         ('[**键盘核对链接**](https://example.invalid/reading-keyboard)\n\n',
                          'reading-motion-19', fixture['conversations'][0])).rowcount
    assert changed == 1
    db.commit()
print(json.dumps({'reading_link_messages': 1, 'runtime': str(runtime)}))
