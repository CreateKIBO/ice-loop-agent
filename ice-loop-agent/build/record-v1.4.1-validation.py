"""Collect completed checks without counting repeated tests twice."""
from __future__ import annotations
import argparse
import json
import re
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path

root=Path(__file__).resolve().parents[1]
docs=root/'docs'
parser=argparse.ArgumentParser()
parser.add_argument('--visual-verified',action='store_true')
args=parser.parse_args()
def read(name: str) -> str:
    return (docs/name).read_text(encoding='utf-8-sig',errors='replace')
def data(name: str):
    return json.loads(read(name))

logs=['v1.4.1-chat-backend.log','v1.4.1-task-lifecycle.log',
      'v1.4.1-task-regression.log','v1.4.1-execution-cancellation-regression.log',
      'v1.4.1-final-workflow-regression.log','v1.4.1-publication-regression.log']
unique=set()
groups={}
for name in logs:
    value=read(name)
    assert value.rstrip().endswith('OK'),name
    # unittest may put a docstring description between the ID and its `ok`.
    ids=set(re.findall(r'^test_\w+ \(([^)]+)\)',value,re.M))
    assert ids,name
    unique.update(ids)
    groups[name]={'passed_unique_in_log':len(ids),'raw_log':True}
assert len(unique)==142,len(unique)
node=read('v1.4.1-node.log')
assert 'pass 35' in node and 'fail 0' in node
source=data('v1.4.1-chat-source.log')
packaged=data('v1.4.1-chat-packaged.log')
required=['deleteConversation','restoreDeletedConversation','archiveConversation','restoreConversation',
          'archiveTask','deleteTask','restoreDeletedTask','deleteTaskKeepsArticle',
          'fastCompletionUnlocks','newConversationStartsDraft','saveDraft','clarificationReply']
for item in (source,packaged):
    flags={k:v for k,v in item.items() if isinstance(v,bool)}
    assert len(flags)==48 and all(flags.values()),flags
    assert all(item.get(key) is True for key in required),item
for source_name,destination in [('release-source-check.json','v1.4.1-package-source-audit.json'),
                                ('release-binary-check.json','v1.4.1-package-binary-audit.json')]:
    shutil.copy2(root/'.test-tmp'/source_name,docs/destination)
source_audit=data('v1.4.1-package-source-audit.json')
binary_audit=data('v1.4.1-package-binary-audit.json')
assert source_audit['version']=='1.4.1' and source_audit['renderer_matches_source']
assert binary_audit['version']=='1.4.1' and binary_audit['setup_payload_matches_unpacked']
assert binary_audit['zip_matches_unpacked'] and binary_audit['engine_matches_latest_build']
assert binary_audit['user_data_included'] is False
runtime=Path(packaged['runtime'])
screens=docs/'screenshots/v1.4.1'
screens.mkdir(parents=True,exist_ok=True)
for filename in runtime.glob('chat-*.png'):
    shutil.copy2(filename,screens/filename.name)
transitions=json.loads((runtime/'chat-progress-stages.json').read_text(encoding='utf-8'))
assert 'receiving' in transitions and len(transitions)>=2,transitions
result={
    'version':'1.4.1',
    'recorded_at':datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).isoformat(),
    'python':{'passed_unique_related_tests':len(unique),'logs':groups,'ids':sorted(unique),
              'repeated_runs_counted_once':True},
    'node':{'passed':35,'failed':0,'log':'v1.4.1-node.log'},
    'source_desktop':{'passed':48,'result':source},
    'packaged_desktop':{'passed':48,'result':packaged,'observed_ui_phases':transitions},
    'packaged_ui_visually_verified':args.visual_verified,
    'release_source':source_audit,'release_binaries':binary_audit,
    'real_failure_evidence':{'installed_version':'1.4.0','read_only':True,
       'three_received_chars':[3726,4941,5725],'finish_reason':'stop','error_code':'SCHEMA_INVALID',
       'cause':'Model returned complete Markdown; strict JSON parsing discarded it.',
       'previous_failed_body_recovered':False},
    'boundaries':{'paid_model_calls_performed':False,'controlled_local_http_sse_adapter_test':True,
       'actual_user_workspace_modified':False,'actual_user_installation_modified':False,
       'actual_user_records_deleted_or_archived':False,'installer_executed':False,
       'tapnow_login_or_generation_performed':False,'wechat_publication_performed':False,
       'G_pyshot_tmp_used':False},
    'initial_desktop_attempts':['v1.4.1-chat-source-initial-failure.log',
       'v1.4.1-chat-source-stale-toolbar.log'],
    'notes':['Previous failed article bodies were not retained by v1.4.0; retry after upgrade.',
       'Soft deletion and archive preserve saved drafts, articles, assets, approvals and export files.',
       'Fast reply, hidden-task write guards and multi-program cancellation are covered.',
       'Initial short-fixture progress check missed the phase; isolated fixture duration increased.',
       'A stale toolbar race discovered by UI testing was fixed before final verification.']}
(docs/'v1.4.1-验收结果.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'version':'1.4.1','python_unique':len(unique),'node':35,'source':48,'packaged':48}))
