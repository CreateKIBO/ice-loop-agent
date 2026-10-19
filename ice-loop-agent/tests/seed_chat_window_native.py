"""Synthetic long-conversation fixture; no personal articles or model calls."""
import json
import os
import sys
import time
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from ice_agent.creative_chat import CreativeChat
from ice_agent.desktop_service import DesktopService

root = repo / '.test-tmp/release-chat-window' / uuid4().hex[:12]
runtime = root / 'runtime'
runtime.mkdir(parents=True)
(root / '.test-owner.json').write_text('{"purpose":"long conversation native acceptance"}', encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
service = DesktopService(repo, runtime, root / 'articles', auto_consumer=False)
try:
    created = service.call('chat.create', {'title': '长会话压力验收'})
    cid = created['conversation']['id']
    small = service.call('chat.create', {'title': '短会话对照'})['conversation']['id']
    count = 2000
    paragraph = '这是一段用于验证长会话阅读和滚动位置的合成文字，不来自用户文章。' * 3
    content = '\n\n'.join([paragraph] * 60) + '\n\n```python\nprint("CHAT_WINDOW_COPY")\n```\n\n| 事项 | 结果 |\n|---|---|\n|分页|完整|'
    _, _, store = service._app()
    try:
        for i in range(count):
            text = f'## 合成消息 {i:04d}\n\n' + content
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                (f'long-{i}', cid, 'assistant' if i % 2 else 'user', text, 'completed', '{}', '2026-10-16T12:00:00Z'))
        for i in range(20):
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                (f'short-{i}', small, 'assistant', f'## 短会话 {i}\n\n对照消息。', 'completed', '{}', '2026-10-16T12:00:00Z'))
        candidates = [CreativeChat._insert_candidate(store, 'ice-loop', cid,
            f'候选稿 {i:03d}', f'# 候选稿 {i:03d}\n\n' + paragraph * 50, created['current'], [], None) for i in range(120)]
        store.conn.commit()
    finally:
        store.close()
    # Observe transport size/timing only, using real IPC handler responses.
    entry, observed = root / 'observe-main.cjs', root / 'chat-requests.jsonl'
    entry.write_text("const fs=require('node:fs');const {ipcMain}=require('electron');"
        "const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,callback)=>handle(channel,async(...args)=>{"
        "const start=performance.now();const value=await callback(...args);"
        "if(channel==='ice:request'&&args[1]==='chat.get'){const params=args[2]||{};"
        "const row={ms:performance.now()-start,bytes:Buffer.byteLength(JSON.stringify(value)),"
        "limit:params.message_limit,messages:value.messages?.length,candidates:value.candidates?.length};"
        f"fs.appendFileSync({json.dumps(str(observed))},JSON.stringify(row)+'\\n');}}return value;}});"
        f"require({json.dumps(str(repo / 'desktop/main.cjs'))});", encoding='utf-8')
    # Independent service-level comparison, outside renderer memory sampling.
    comparisons = {}
    for name, params in [('bounded', {'message_limit': 40, 'candidate_limit': 3}), ('legacy', {})]:
        start = time.perf_counter()
        value = service.call('chat.get', {'conversation_id': cid, **params})
        comparisons[name] = {'ms': (time.perf_counter() - start) * 1000,
                             'bytes': len(json.dumps(value, ensure_ascii=False).encode()),
                             'messages': len(value['messages']), 'candidates': len(value['candidates'])}
        del value
    fixture = dict(runtime=str(runtime), conversation=cid, small=small, count=count,
                   candidates=candidates, entry=str(entry), observed=str(observed), comparison=comparisons)
    (repo / 'docs/上线准备/chat-window-fixture.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in fixture.items() if k != 'candidates'}, ensure_ascii=False))
finally:
    service.close()
