"""Owned local responsive-workbench fixture; no user data or model calls."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from tests.test_workflow import demo_spec

root = repo / '.test-tmp/release-layout' / uuid4().hex[:12]
runtime = root / 'runtime'
runtime.mkdir(parents=True)
(root / '.test-owner.json').write_text('{"purpose":"responsive workbench acceptance"}', encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
service = DesktopService(repo, runtime, root / 'articles', auto_consumer=False)
try:
    conversation = service.call('chat.create', {'title': '布局验收对话'})['conversation']['id']
    other = service.call('chat.create', {'title': '另一个布局对话'})['conversation']['id']
    engine, _, store = service._app(demo=True)
    try:
        job, article = engine.create_job({**demo_spec(), 'demo': True, 'account_id': 'ice-loop', 'topic': '布局验收文章'})
        state = engine._load_state(job)
        state['integrated_md'] = '# 布局验收文章\n\n布局切换不会重建这份正文。\n'
        store.save_checkpoint(job, state)
        store.update_job(job, state='completed', current_node='export', lease=None)
    finally:
        store.close()
    fixture = {'runtime': str(runtime), 'job': job, 'article': article,
               'conversation': conversation, 'other': other}
    # Count IPC method names only; no parameters, credentials, response or scheduling changes.
    entry = root / 'observe-main.cjs'
    counts = root / 'rpc-counts.json'
    entry.write_text("const fs=require('node:fs');const {ipcMain}=require('electron');"
        "const handle=ipcMain.handle.bind(ipcMain),counts={};"
        "ipcMain.handle=(channel,callback)=>handle(channel,(...args)=>{"
        "if(channel==='ice:request'){const method=args[1];counts[method]=(counts[method]||0)+1;"
        f"fs.writeFileSync({json.dumps(str(counts))},JSON.stringify(counts));}}"
        "return callback(...args);});"
        f"require({json.dumps(str(repo / 'desktop/main.cjs'))});", encoding='utf-8')
    fixture.update(entry=str(entry), counts=str(counts))
    (repo / 'docs/上线准备/layout-fixture.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(fixture, ensure_ascii=False))
finally:
    service.close()
