"""只建立本轮G盘隔离fixture，不执行模型或文章程序。"""
from __future__ import annotations
import json
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import new_id, now_iso
from tests.test_workflow import demo_spec

runtime = repo / '.test-tmp' / 'reaccept-beta1-20261008' / ('native-package' if '--packaged' in sys.argv else 'native-source-final')
runtime.mkdir(parents=True, exist_ok=True)
service = DesktopService(repo, runtime, runtime / 'articles')
engine, _, store = service._app(demo=True)
try:
    job, article = engine.create_job({**demo_spec(), 'demo': True, 'account_id': 'ice-loop', 'article_root': str(runtime / 'articles')})
    body = '# 原生验收文章\n\nNATIVE_ORIGINAL_PARAGRAPH\n\n## 写在最后\n\n这是本轮隔离测试夹具，不是发布文章。\n'
    state = engine._load_state(job)
    state.update(integrated_md=body, draft_md=body)
    engine._save_state(job, state)
    store.update_job(job, state='completed', current_node='export')
    conv = service.call('chat.create', {'title': '原生验收已有会话', 'series': 'PY'})
    cid = conv['conversation']['id']
    store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)', (new_id('message'), cid, 'user', '已存在的用户消息', 'completed', '{}', now_iso()))
    store.conn.commit()

    archived = service.call('chat.create', {'title': '归档验收会话'})
    service.call('chat.update', {'conversation_id': archived['conversation']['id'], 'archived': True})
    candidate_id = new_id('candidate')
    store.conn.execute('INSERT INTO creative_candidates (id,conversation_id,account_id,title,body,base_json,prompts_json,status,parent_id,review_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        (candidate_id,cid,'ice-loop','候选保存验收','# 候选保存验收\n\nDRAFT_NATIVE_MARKER',json.dumps(conv['current']), '[]','draft',None,'{}',now_iso()))
    store.conn.commit()
    result = {'runtime': str(runtime), 'job_id': job, 'article_id': article, 'conversation_id': cid, 'body': body}
    (runtime / 'review-fixture.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'runtime': str(runtime), 'job_id': job, 'conversation_id': cid}, ensure_ascii=False))
finally:
    store.close()
    service.close()
