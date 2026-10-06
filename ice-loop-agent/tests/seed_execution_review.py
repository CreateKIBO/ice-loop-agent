"""Seed an isolated desktop regression fixture, never a production task."""
import json
import sys
from pathlib import Path
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_json

root=Path(__file__).resolve().parents[1];runtime=Path(sys.argv[1]).resolve()
if root/'.test-tmp' not in runtime.parents:raise ValueError('Fixture requires project .test-tmp')
service=DesktopService(root,runtime,runtime/'articles')
engine,cfg,store=service._app(demo=True)
try:
    job_id,article_id=engine.create_job({'series':'PY','episode':111,'topic':'交互代码验证回归','demo':True,'approve_local_exec':False,'account_id':'ice-loop','article_root':str(runtime/'articles')})
    state=engine._load_state(job_id)
    state['draft_md']='# 交互代码验证回归\n\n```python\nname = input("姓名：")\nprint("你好，" + name)\n```\n'
    state['series']='PY'
    state['execution_approval']=sha256_json({'draft':state['draft_md'],'stdin':{}})
    engine._save_state(job_id,state)
    store.update_job(job_id,state='awaiting_user',current_node='verify_code',pause_reason='缺少输入：旧版界面误报需要重复审阅')
    (runtime/'review-fixture.json').write_text(json.dumps({'job_id':job_id}),encoding='utf-8')
finally:store.close();service.close()
