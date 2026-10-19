"""Owned settings fixture: mock ledger entries, never real model requests."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-budget'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"native global budget settings acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):os.environ.pop(key,None)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    title='预算设置验收会话'
    conversation=service.call('chat.create',{'title':title})['conversation']['id']
    old_job=service.call('jobs.create',{'topic':'预算修改前的任务','series':'PY','episode':71,'demo':True})['job_id']
    _,_,store=service._app()
    try:
        for index,status in enumerate(('ok','MODEL_TRANSPORT_ERROR','MODEL_CAPABILITY_MISMATCH')):
            store.add_invocation({'invocation_id':f'fixture-settings-{index}','conversation_id':conversation,
                'status':status,'adapter':'mock-fixture','model_id':'fixture-only','role':'writer'})
    finally:store.close()
    fixture={'runtime':str(runtime),'conversation':conversation,'title':title,'old_job':old_job,
        'ledger_entries':3,'charged_entries':2,'cloud_calls':0}
    atomic_write_text(repo/'docs/上线准备/budget-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:service.close()
