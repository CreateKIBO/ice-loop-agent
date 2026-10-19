"""Bounded G-only event-heavy fixture; does not run models or article code."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import now_iso

runtime = repo/'.test-tmp/release-resources'/uuid4().hex[:12]
runtime.mkdir(parents=True)
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
(runtime/'.test-owner.json').write_text('{"purpose":"event cache native memory test"}',encoding='utf-8')
service = DesktopService(repo,runtime,runtime/'articles',auto_consumer=False)
try:
    _,_,store = service._app()
    try:
        ids=[]
        stamp=now_iso()
        for i in range(40):
            cid='resource-conversation-'+str(i);mid='resource-message-'+str(i)
            store.conn.execute('INSERT INTO creative_conversations VALUES (?,?,?,?,?,0,?)',
                (cid,'ice-loop',f'压力会话{i:02d}','','{}',stamp))
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                (mid,cid,'assistant','这是资源测试的合成回复。','completed',
                 json.dumps({'progress':{'phase':'receiving','started_at':stamp}}),stamp))
            # One transaction avoids tens of thousands of individual disk commits.
            store.conn.executemany('INSERT INTO stream_events (stream_id,sequence,event_id,account_id,event_type,payload,created_at) VALUES (?,?,?,?,?,?,?)',
                [('chat:'+cid,j,'evt-'+cid+'-'+str(j),'ice-loop','tool.started' if j==180 else 'turn.phase',
                  json.dumps({'turn_id':mid,'phase':'receiving','tool':'list_task_status','detail':('测试事件 '+str(j)+' ')*180},ensure_ascii=False),stamp)
                 for j in range(1,181)])
            ids.append(cid)
        store.conn.commit()
    finally:
        store.close()
    out=repo/'docs/上线准备';out.mkdir(parents=True,exist_ok=True)
    result={'runtime':str(runtime),'conversations':ids,'events_per_thread':180,'threads':len(ids)}
    (out/'resource-fixture.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'runtime':str(runtime),'threads':len(ids),'events':len(ids)*180},ensure_ascii=False))
finally:
    service.close()
