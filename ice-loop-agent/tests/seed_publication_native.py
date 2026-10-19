"""Fresh local onboarding fixture, no real model keys or user publication data."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-publication'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"native publication onboarding acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    bundle=service.accounts_export({})
    bundle['account'].update(name='纸间观察',audience='城市散步者',preset='ice-loop',id='foreign-import',
        colors='#356B58, #182821, #F3F2ED',slogan='把观察留在纸上。',
        columns=[{'code':'OBS','name':'观察手记'},{'code':'LAB','name':'日常实验'}],
        brand_document='品牌资料原文。<script>window.__BRAND_XSS=true</script>',
        article_root=str(root/'foreign-output'),library_root=str(root/'foreign-library'))
    config=root/'纸间观察.json';atomic_write_text(config,json.dumps(bundle,ensure_ascii=False))
    invalid=root/'invalid.json';atomic_write_text(invalid,'{"bad JSON')
    library=root/'library'
    for episode in range(1,15):
        atomic_write_text(library/'OBS'/f'{episode:03d}-观察记录{episode}'/'01-公众号正文.md',f'# 观察记录{episode}\n\n这是只读的历史原稿。\n')
    fixture={'runtime':str(runtime),'config':str(config),'invalid':str(invalid),'library':str(library)}
    atomic_write_text(repo/'docs/上线准备/publication-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:service.close()
