"""Owned 1,500-article source-Electron fixture; explicitly offline generation."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.llm.capabilities import preset_profile
from ice_agent.paths import atomic_write_text
from tests.test_model_context import seed_history

root = repo/'.test-tmp/release-context'/uuid4().hex[:12]
runtime = root/'runtime'
runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json', '{"purpose":"long history model input native acceptance"}')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
service = DesktopService(repo, runtime, root/'articles', auto_consumer=False)
try:
    first = service._account()
    service.accounts_save({'account': {**first, 'library_root': ''}})
    account = {key: value for key, value in first.items() if key != 'id'}
    account.update(preset='general', name='纸间观察 · 长历史写作', audience='日常观察的读者', library_root='',
                   article_root=str(root/'observations'), columns=[{'code':'OBS','name':'观察手记'}])
    aid = service.accounts_save({'account': account})['saved_account_id']
    store = Store(runtime/'app.db')
    try: seed_history(store, aid, 'OBS')
    finally: store.close()
    profile = preset_profile('mock', profile_id='context-offline-fixture')
    profile.update(api_key_env='ICE_CONTEXT_FAKE_KEY', status='verified', model_id='offline-context-only')
    service.settings['profiles'] = {'offline': profile}
    for route in service.settings['routes'].values(): route.update(primary=profile['profile_id'], fallbacks=[])
    atomic_write_text(service.settings_file, json.dumps(service.settings, ensure_ascii=False, indent=2))
    entry = root/'context-main.cjs'
    atomic_write_text(entry, "process.env.ICE_CONTEXT_FAKE_KEY='fixture-only-never-a-real-key';\nrequire("+json.dumps(str(repo/'desktop/main.cjs'))+");\n")
    fixture = {'root':str(root), 'runtime':str(runtime), 'entry':str(entry), 'account_id':aid,
               'history_count':1500, 'offline_model':True}
    atomic_write_text(repo/'docs/上线准备/context-fixture.json', json.dumps(fixture, ensure_ascii=False, indent=2))
    print(json.dumps(fixture, ensure_ascii=False))
finally: service.close()
