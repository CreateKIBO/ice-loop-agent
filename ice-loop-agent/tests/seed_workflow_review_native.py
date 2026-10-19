"""G-only real approval gates, offline model routes; actual code runs only after UI consent."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_json
from tests.test_workflow import demo_spec

root=repo/'.test-tmp/release-workflow-review'/uuid4().hex[:12]
runtime=root/'runtime'
runtime.mkdir(parents=True)
(root/'.test-owner.json').write_text('{"purpose":"native workflow review fixture"}',encoding='utf-8')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
engine,_,store=service._app(demo=True)
try:
    jobs={}
    for key,title in [('main','完整工作流审阅验收'),('reject','否决流程验收'),('stale','旧候选冲突验收')]:
        job,article=engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop',
            'approve_local_exec':False,'topic':title})
        result=engine.run(job)
        assert result['state']=='awaiting_approval'
        if key=='main':
            state=engine._load_state(job)
            payload=state['model_candidates']['topic']['data']
            payload['directions'][0]['标题候选']='<script>window.__REVIEW_XSS=true</script>'
            state['model_candidates']['topic']['text']=json.dumps(payload,ensure_ascii=False)
            approval=store.pending_approval(job)
            store.conn.execute('UPDATE approvals SET payload=?,content_hash=? WHERE approval_id=?',
                (json.dumps(payload,ensure_ascii=False),sha256_json(payload),approval['approval_id']))
            store.save_checkpoint(job,state)
        jobs[key]=job
    marker=runtime/'native-cancel-started.pid'
    job,_=engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop',
        'approve_local_exec':False,'topic':'运行中暂停验收'})
    state=engine._load_state(job)
    state['draft_md']=('# 正文\n```python\nimport os, time\nfrom pathlib import Path\n'
        'print("NATIVE_PROGRAM_STARTED", flush=True)\n'
        f'Path({str(marker)!r}).write_text(str(os.getpid()))\n'
        'time.sleep(30)\n```\n<!--RUN_OUTPUT:run-1-->\n')
    engine._save_state(job,state)
    store.update_job(job,current_node='verify_code',state='awaiting_user',pause_reason='请审阅本次真实运行程序')
    jobs['cancel']=job
    fixture={'runtime':str(runtime),'cancel_marker':str(marker),**jobs}
    (repo/'docs/上线准备/workflow-review-fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(fixture,ensure_ascii=False))
finally:
    store.close()
    service.close()
