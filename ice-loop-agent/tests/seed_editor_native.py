"""Synthetic completed article for editor persistence acceptance; no workflow/model run."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from tests.test_workflow import demo_spec

root = repo/'.test-tmp/release-editor'/uuid4().hex[:12]
runtime = root/'runtime'
runtime.mkdir(parents=True)
(root/'.test-owner.json').write_text('{"purpose":"synthetic editor persistence acceptance"}',encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
service = DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    conversation = service.call('chat.create',{'title':'编辑器验收对话'})['conversation']['id']
    engine,_,store = service._app(demo=True)
    try:
        job,article = engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop','topic':'编辑器验收文章'})
        state = engine._load_state(job)
        state['integrated_md'] = '# 编辑器验收文章\n\n初始正文内容。\n'
        store.save_checkpoint(job,state)
        store.update_job(job,state='completed',current_node='export',lease=None)
        waiting,_ = engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop','topic':'等待示例输入的文章'})
        store.update_job(waiting,state='awaiting_user',current_node='verify_code',
            pause_reason='请补充示例输入，并审阅当前代码后执行。')
    finally: store.close()
    fixture = {'runtime':str(runtime),'job':job,'article':article,'conversation':conversation,'waiting':waiting}
    (repo/'docs/上线准备/editor-fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(fixture,ensure_ascii=False))
finally: service.close()
