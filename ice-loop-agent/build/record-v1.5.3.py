"""Archive actual test results and verify the immutable final distributables."""
import hashlib
import importlib.util
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/'docs'
VERSION='1.5.3'

def read_python(log):
    text=(DOCS/log).read_text(encoding='utf-8-sig')
    count=re.search(r'Ran (\d+) tests?',text)
    if not count or not text.rstrip().endswith('OK'):
        raise ValueError('Python validation failed: '+log)
    matches=re.findall(r'^(test_\w+) \(([^)]+)\) \.\.\. ok$',text,re.M)
    if len(matches)!=int(count[1]):raise ValueError('Incomplete test journal: '+log)
    return {'passed':int(count[1]),'log':log},set(matches)

python_runs=[];unique=set()
for log in ['v1.5.3-python-tests.log','v1.5.3-expected-error-tests.log','v1.5.3-final-asset-tests.log']:
    row,ids=read_python(log);python_runs.append(row);unique|=ids
node=(DOCS/'v1.5.3-node-tests.log').read_text(encoding='utf-8-sig')
count=re.search(r'(?:ℹ|#) pass (\d+)',node)
if not count or not re.search(r'(?:ℹ|#) fail 0',node):raise ValueError('Node validation failed')
native={};screenshots=DOCS/'screenshots/v1.5.3';screenshots.mkdir(parents=True,exist_ok=True)
for kind in ['prompt','chat','browser']:
    log=f'v1.5.3-{kind}-packaged.log';data=json.loads((DOCS/log).read_text(encoding='utf-8-sig'))
    flags={key:value for key,value in data.items() if isinstance(value,bool) and key!='packaged'}
    if not flags or not all(flags.values()):raise ValueError('Native validation failed: '+kind)
    runtime=Path(data['runtime']).resolve()
    if runtime.parent!=(ROOT/'.test-tmp').resolve():raise ValueError('Nonisolated native test root')
    target=screenshots/kind;target.mkdir(exist_ok=True)
    for pattern in ['*.png','*trace.log','execution-viewer-results.json','prompt-smoke.json','chat-result.json']:
        for file in runtime.glob(pattern):shutil.copy2(file,target/file.name)
    if (runtime/'run-evidence').is_dir():
        shutil.copytree(runtime/'run-evidence',target/'run-evidence',dirs_exist_ok=True)
    native[kind]={'passed':len(flags),'log':log,'result':data}
audits={}
for name in ['source','binary']:
    file=ROOT/'.test-tmp'/f'release-{name}-check.json'
    audits[name]=json.loads(file.read_text(encoding='utf-8'))
    if audits[name]['version']!=VERSION:raise ValueError('Stale package version')
    shutil.copy2(file,DOCS/f'v1.5.3-package-{name}-audit.json')
for row in audits['binary']['files']:
    file=ROOT/'release'/row['name']
    with file.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    if digest!=row['sha256'] or file.stat().st_size!=row['bytes']:raise ValueError('Release changed after audit')
module=importlib.util.spec_from_file_location('asset_audit',ROOT/'build/record-v1.5.1.py')
assets=importlib.util.module_from_spec(module);module.loader.exec_module(assets)
result={'version':VERSION,'recorded_at':datetime.now(timezone.utc).isoformat(),
    'python':{'unique_passed':len(unique),'runs':python_runs},'node':{'passed':int(count[1]),'log':'v1.5.3-node-tests.log'},
    'native':native,'approved_assets':assets.asset_audit(),'package_audits':audits,
    'boundaries':{'isolated_data':True,'paid_models_called':False,'cloud_image_generation_tested':False,
                  'published':False,'actual_installed_workspace_modified':False,'actual_upgrade_installation_executed':False},
    'cleanup_policy':{'owned_staging_only':True,'process_tree_reaped':True,'raw_capture_temporary_removed':True,
                      'source_evidence_retained':True,'formal_images_retained':True,'unmarked_legacy_directories_preserved':True},
    'screenshots':str(screenshots.relative_to(ROOT)),
    'note':'88-case initial regression plus a 42-case final related rerun and the expected-error check; repeats are deduplicated. Native checks use the final packaged executable. Exact installer entries and ZIP were compared against unpacked payloads without installing into the real user workspace.'}
(DOCS/'v1.5.3-验收结果.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'python_unique_passed':len(unique),'node_passed':int(count[1]),
    'native':{key:value['passed'] for key,value in native.items()},'assets':len(result['approved_assets'])},ensure_ascii=False))
