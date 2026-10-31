"""Owned reading fixture plus synthetic messages; no model request or personal data."""
import json
import runpy
import sqlite3
from contextlib import closing
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
runpy.run_path(str(repo / 'tests/seed_reading_upgrade_native.py'))
fixture = json.loads((repo / 'docs/上线准备/reading-upgrade-fixture.json').read_text())
root, runtime = Path(fixture['root']), Path(fixture['runtime'])
assert root.parent == repo / '.test-tmp/release-interaction-lists'
assert (root / '.test-owner.json').is_file() and runtime == root / 'runtime'
with closing(sqlite3.connect(runtime / 'app.db')) as db:
    conversation = fixture['conversations'][0]
    assert db.execute('SELECT count(*) FROM creative_messages WHERE conversation_id=?', (conversation,)).fetchone()[0] == 0
    for index in range(20):
        text = f'## 阅读动效夹具 {index}\n\n' + ('这是合成阅读内容，用于核对滚动与减少动态策略。\n\n' * 12)
        db.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                   (f'reading-motion-{index:02d}', conversation, 'assistant' if index % 2 else 'user',
                    text, 'completed', '{}', f'2026-10-31T00:00:{index:02d}Z'))
    db.commit()
print(json.dumps({'reading_motion_messages': 20, 'runtime': str(runtime)}))
