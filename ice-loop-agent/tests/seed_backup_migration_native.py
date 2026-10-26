"""Synthetic schema-19 bundle with two accounts; native restore stays in owned roots."""
import copy
import hashlib
import json
import runpy
import sqlite3
import sys
import zipfile
from contextlib import closing
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
runpy.run_path(str(repo / 'tests/seed_backup_native.py'), run_name='__main__')
from tests.schema_fixtures import downgrade_to_19
from ice_agent.migrations import MAX_KNOWN_VERSION
from ice_agent.backup import create_backup, digest
from ice_agent.desktop_service import DesktopService

f = json.loads((repo / 'docs/上线准备/backup-fixture.json').read_text(encoding='utf-8'))
root, runtime = Path(f['root']), Path(f['runtime'])
service = DesktopService(repo, runtime, root / 'articles', auto_consumer=False)
try:
    account = copy.deepcopy(service._account())
    account.pop('id')
    account.update(name='迁移验收第二公众号', article_root=str(root / 'second-articles'), library_root='')
    f['secondary_account'] = service.accounts_save({'account':account})['saved_account_id']
    service.call('chat.create', {'title':'第二公众号的恢复会话'})
    service.call('accounts.switch', {'account_id':'ice-loop'})
    current = root / 'multi-account.zip'
    create_backup(runtime, service.settings, current)
finally:
    service.close()

with zipfile.ZipFile(current) as source:
    contents = {name:source.read(name) for name in source.namelist()}
manifest = json.loads(contents.pop('manifest.json'))
database = root / 'synthetic-schema-19.db'
database.write_bytes(contents['runtime/app.db'])
with closing(sqlite3.connect(database)) as db:
    downgrade_to_19(db)
    db.execute("UPDATE schema_migrations SET checksum='fixture-legacy-code-only' WHERE version=10")
    db.execute('PRAGMA user_version=19')
    db.commit()
contents['runtime/app.db'] = database.read_bytes()
manifest['app_version'] = 'synthetic-schema-19-fixture'
manifest['files'] = {name:{'size':len(body),'sha256':hashlib.sha256(body).hexdigest()} for name,body in contents.items()}
package = root / 'schema-19.zip'
with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name,body in contents.items():
        bundle.writestr(name, body)
    bundle.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
f.update(package=str(package), package_hash=digest(package), source_schema=19, target_schema=MAX_KNOWN_VERSION,
         synthetic_historical_schema=True, legacy_unverified=[10])
(root / 'dialog-plan.json').write_text(json.dumps([
    {'kind':'open','canceled':False,'filePaths':[str(package)]},
    {'kind':'open','canceled':False,'filePaths':[str(root)]},
]), encoding='utf-8')
entry = Path(f['entry'])
entry.write_text("require('electron').app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));\n" + entry.read_text(encoding='utf-8'), encoding='utf-8')
(repo / 'docs/上线准备/backup-migration-fixture.json').write_text(json.dumps(f, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'migration_fixture':str(root),'source_schema':19,'accounts':2}))
