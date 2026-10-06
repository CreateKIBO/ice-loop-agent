"""Collect completed tests and audit the final distributables, without rerunning them."""
import hashlib
import importlib.util
import json
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/'docs'
spec=importlib.util.spec_from_file_location('approved_asset_audit',ROOT/'build/record-v1.5.1.py')
assets_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets_module)

def python_result(name):
    log=(DOCS/name).read_text(encoding='utf-8-sig')
    match=re.search(r'Ran (\d+) tests',log)
    if not match or not log.rstrip().endswith('OK'):raise ValueError('Failed Python check: '+name)
    return {'passed':int(match[1]),'log':name}

native={};screenshots=DOCS/'screenshots/v1.5.2';screenshots.mkdir(parents=True,exist_ok=True)
for name in ['prompt-packaged','chat-packaged','browser-packaged']:
    logfile=f'v1.5.2-{name}.log'
    data=json.loads((DOCS/logfile).read_text(encoding='utf-8-sig'))
    flags={key:value for key,value in data.items() if isinstance(value,bool) and key!='packaged'}
    if not flags or not all(flags.values()):raise ValueError('Failed native check: '+name)
    runtime=Path(data['runtime']).resolve()
    if not runtime.is_relative_to((ROOT/'.test-tmp').resolve()):raise ValueError('Nonisolated test root')
    folder=screenshots/name;folder.mkdir(exist_ok=True)
    for file in runtime.glob('*.png'):shutil.copy2(file,folder/file.name)
    for file in runtime.glob('*trace.log'):shutil.copy2(file,folder/file.name)
    native[name]={'passed':len(flags),'log':logfile,'result':data}

node=(DOCS/'v1.5.2-node-tests.log').read_text(encoding='utf-8-sig')
count=re.search(r'(?:ℹ|#) pass (\d+)',node)
if not count or not re.search(r'(?:ℹ|#) fail 0',node):raise ValueError('Node checks failed')
audits={}
for name in ['source','binary']:
    file=ROOT/'.test-tmp'/f'release-{name}-check.json'
    audits[name]=json.loads(file.read_text(encoding='utf-8'))
    if audits[name]['version']!='1.5.2':raise ValueError('Package version mismatch')
    shutil.copy2(file,DOCS/f'v1.5.2-package-{name}-audit.json')
for row in audits['binary']['files']:
    file=ROOT/'release'/row['name']
    with file.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    if file.stat().st_size!=row['bytes'] or digest!=row['sha256']:raise ValueError('Release changed after audit')

result={'version':'1.5.2','recorded_at':datetime.now(timezone(timedelta(hours=8))).isoformat(),
    'python':python_result('v1.5.2-python-final.log'),
    'budget_final_recheck':python_result('v1.5.2-budget-final.log'),
    'node':{'passed':int(count[1]),'log':'v1.5.2-node-tests.log'},
    'native':native,'approved_assets':assets_module.asset_audit(),'package_audits':audits,
    'boundaries':{'isolated_data':True,'offline_models':True,'paid_models_called':False,
        'real_cloud_generation_tested':False,'published':False,'actual_upgrade_installation_executed':False},
    'screenshots':str(screenshots.relative_to(ROOT)),
    'note':'Budget-only final recheck repeats five of the 35 Python tests. Final native acceptance uses the distributable executable; preliminary source tests found the inherited checkbox minimum height, fixed before packing. Installer entries were streamed and checked by size and SHA256 without running installation.'}
(DOCS/'v1.5.2-验收结果.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'python':result['python']['passed'],'node':int(count[1]),
    'native':{key:value['passed'] for key,value in native.items()},'assets':len(result['approved_assets'])},ensure_ascii=False))
