"""Source desktop fixture: saved model metadata only, no live provider discovery."""
import json,os,sys
from pathlib import Path
from uuid import uuid4
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.llm.capabilities import preset_profile
from ice_agent.llm.limits import window_metadata
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-generation'/uuid4().hex[:12];runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"model output controls native acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    service.accounts_save({'account':{**service._account(),'library_root':''}})
    profile=preset_profile('mock',profile_id='generation-offline-fixture')
    profile.update(model_id='explicit-offline-model',base_url='https://example.invalid/v1',api_key_env='ICE_GENERATION_FAKE_KEY',status='verified')
    profile['extra']={'model_window':window_metadata(profile,[{'id':profile['model_id'],'context_window':32000,'max_output_tokens':8192}]),'max_output_tokens':4096}
    service.settings['profiles']={'qwen':profile}
    for route in service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
    atomic_write_text(service.settings_file,json.dumps(service.settings,ensure_ascii=False,indent=2))
    entry=root/'generation-main.cjs'
    atomic_write_text(entry,"process.env.ICE_GENERATION_FAKE_KEY='fixture-only-never-a-real-key';require("+json.dumps(str(repo/'desktop/main.cjs'))+");")
    fixture={'root':str(root),'runtime':str(runtime),'entry':str(entry),'account_id':'ice-loop','window_metadata_seeded':True,'cloud_calls':0}
    atomic_write_text(repo/'docs/上线准备/generation-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:service.close()
