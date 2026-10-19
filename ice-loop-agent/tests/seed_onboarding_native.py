"""Owned fresh workspace with one explicitly offline model, never a real provider Key."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.llm.capabilities import preset_profile
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-onboarding'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"first article and routing acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    profile=preset_profile('mock',profile_id='onboarding-offline-fixture')
    profile.update(api_key_env='ICE_ONBOARDING_FAKE_KEY',status='verified',model_id='offline-first-draft')
    service.settings['profiles']['kimi']=profile
    atomic_write_text(service.settings_file,json.dumps(service.settings,ensure_ascii=False,indent=2))
    library=root/'history'
    for n in range(1,15):
        atomic_write_text(library/'OBS'/f'{n:03d}-观察记录{n}'/'01-公众号正文.md',f'# 观察记录{n}\n\n这是自己的历史原稿，第{n}篇。\n')
    bundle=service.accounts_export({})
    bundle['account'].update(id='foreign',preset='general',name='纸间观察',audience='城市散步者',
        positioning='记录日常观察与可操作的方法',columns=[{'code':'OBS','name':'观察手记'}],
        article_root=str(root/'untrusted-output'),library_root=str(root/'untrusted-history'))
    config=root/'纸间观察.json';atomic_write_text(config,json.dumps(bundle,ensure_ascii=False))
    entry=root/'offline-main.cjs'
    atomic_write_text(entry,"process.env.ICE_ONBOARDING_FAKE_KEY='fixture-only-not-a-real-key';"
        f"require({json.dumps(str(repo/'desktop/main.cjs'))});")
    fixture={'runtime':str(runtime),'entry':str(entry),'profile':profile['profile_id'],
        'config':str(config),'library':str(library)}
    atomic_write_text(repo/'docs/上线准备/onboarding-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:service.close()
