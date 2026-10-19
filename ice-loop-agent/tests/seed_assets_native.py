"""Isolated workspace-local mock article; real code/evidence and fixture images."""
import copy
import json
import os
import sys
from pathlib import Path
from uuid import uuid4
from PIL import Image, ImageDraw

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.workspace_assets import WorkspaceAssets
from tests.test_workflow import demo_spec

root=repo/'.test-tmp/release-assets'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
(root/'.test-owner.json').write_text('{"purpose":"native assets workflow acceptance"}',encoding='utf-8')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):os.environ.pop(key,None)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
engine,_,store=service._app(demo=True)
try:
    job,article=engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop'})
    result=engine.run(job,auto_approver=lambda scope,payload:('approve','offline acceptance fixture',None))
    assert result['state']=='completed',result
    slots=store.article_slots(article)
    cover=next(row for row in slots if row['kind']=='cover')
    real=next(row for row in slots if row['kind']=='body_real')
    generative=next(row for row in slots if row['kind'] not in ('cover','body_real'))
    large=root/'large.png'
    image=Image.new('RGB',(2400,1400),'#F3F2ED');draw=ImageDraw.Draw(image)
    for x in range(0,2400,100):draw.line((x,0,x,1400),fill='#2448DB',width=2)
    draw.text((30,30),'ORIGINAL PIXELS 2400 x 1400 / NATIVE FIXTURE',fill='#15191F')
    image.save(large)
    selected=engine.import_asset(job,cover['figure_no'],large,accept=True)
    alternate=root/'alternate.png';Image.new('RGB',(1600,1000),'#2448DB').save(alternate)
    pending=engine.import_asset(job,cover['figure_no'],alternate,accept=False)
    box=WorkspaceAssets(store,runtime,'ice-loop')
    for i in range(16):
        file=root/f'resource-{i}.png';Image.new('RGB',(400+i,240),(25+i*8,50+i*5,170)).save(file)
        resource=box.import_image(file);resource.update(title=f'资源-{i:02d}',usage='illustration',description='native fixture',tags=['循环'] if i==15 else [])
        if i==15:resource.update(title='循环图解资源',style_reference=True)
        box.save_resource(resource)
    other=copy.deepcopy(service.settings['accounts']['ice-loop'])
    other.update(id='other',name='验收公众号二',preset='general',article_root=str(root/'other-articles'),library_root='')
    service.settings['accounts']['other']=other
    service.settings_file.write_text(json.dumps(service.settings,ensure_ascii=False,indent=2),encoding='utf-8')
    fixture={'runtime':str(runtime),'job':job,'article':article,'cover':cover['figure_no'],'real':real['figure_no'],'generative':generative['figure_no'],
        'selected':selected['candidate_id'],'pending':pending['candidate_id'],'pending_file':pending['file_path'],'large':str(large),'export_parent':str(root/'exports')}
    (root/'exports').mkdir()
    (repo/'docs/上线准备/assets-fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(fixture,ensure_ascii=False))
finally:store.close();service.close()
