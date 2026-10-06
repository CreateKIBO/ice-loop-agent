"""Record completed v1.4 checks, retaining the provenance of agent test evidence."""
import json
import argparse
import re
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path

root=Path(__file__).resolve().parents[1]
docs=root/'docs'
parser=argparse.ArgumentParser()
parser.add_argument('--visual-verified',action='store_true')
args=parser.parse_args()
def read(name):return (docs/name).read_text(encoding='utf-8-sig',errors='replace')
def data(name):return json.loads(read(name))

backend_logs=['v1.4-backend-24-evidence.log','v1.4-backend-2-evidence.log']
backend_names=set()
for name in backend_logs:
    value=read(name)
    assert 'Observed process exit code: 0' in value and 'OK' in value,name
    backend_names.update(re.findall(r'^(test_\w+)',value,re.M))
assert len(backend_names)==26,len(backend_names)
raw_logs=['v1.4-router-history.log','v1.4-article-regression.log']
other_ids=set()
for name in raw_logs:
    value=read(name)
    assert value.rstrip().endswith('OK'),name
    other_ids.update(re.findall(r'^test_.*? \(([^)]+)\)',value,re.M))
assert len(other_ids)==63,len(other_ids)
node=read('v1.4-node.log')
assert 'pass 35' in node and 'fail 0' in node
source=data('v1.4-chat-source.log')
packaged=data('v1.4-chat-packaged.log')
for item in [source,packaged]:
    flags={k:v for k,v in item.items() if isinstance(v,bool)}
    assert len(flags)==34 and all(flags.values()),flags

for source_name,destination in [('release-source-check.json','v1.4-package-source-audit.json'),
                                ('release-binary-check.json','v1.4-package-binary-audit.json')]:
    shutil.copy2(root/'.test-tmp'/source_name,docs/destination)
package_source=data('v1.4-package-source-audit.json')
package_binary=data('v1.4-package-binary-audit.json')
assert package_source['renderer_matches_source'] and package_source['version']=='1.4.0'
assert package_binary['setup_payload_matches_unpacked'] and package_binary['zip_matches_unpacked']
assert package_binary['version']=='1.4.0'

screens=docs/'screenshots/v1.4';screens.mkdir(parents=True,exist_ok=True)
runtime=Path(packaged['runtime'])
for image in runtime.glob('chat-*.png'):shutil.copy2(image,screens/image.name)
transitions=json.loads((runtime/'chat-progress-stages.json').read_text(encoding='utf-8'))
assert 'receiving' in transitions and len(transitions)>=2
result={
    'version':'1.4.0','recorded_at':datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).isoformat(),
    'python':{'passed_unique_related_tests':89,'groups':{'creative_chat':26,'history_router':25,'publication_supplements_workbench':38},
              'raw_logs':raw_logs,'creative_chat_evidence_logs':backend_logs,
              'creative_chat_evidence_provenance':'Archived completed subagent tool outputs, explicitly marked; not original redirected logs and not reruns.'},
    'node':{'passed':35,'failed':0,'log':'v1.4-node.log'},
    'source_desktop':{'passed':34,'result':source},
    'packaged_desktop':{'passed':34,'result':packaged,'observed_ui_phases':transitions},
    'packaged_ui_visually_verified':args.visual_verified,
    'release_source':package_source,'release_binaries':package_binary,
    'boundaries':{'paid_model_calls_performed':False,'model_test_used_isolated_offline_fixtures':True,
                  'actual_user_installation_or_workspace_modified':False,'installed_into_actual_user_directory':False,
                  'wechat_login_or_publication_performed':False,'tapnow_login_or_generation_performed':False,
                  'G_pyshot_tmp_used':False},
    'notes':['普通续聊及文章入口复用按会话ID和文章来源处理，旧分支全部保留，没有按名称删改。',
             '初稿保存和审批分开，重复保存幂等，草稿被人工编辑后拒绝旧候选覆盖。',
             '二轮澄清、失败重试、保存后分支和账号切换分别补充回归。',
             '受限环境原生初始化未完成，自动审批提升权限后在G盘隔离工作区验收。',
             '最终窗口无焦点显示以激活真实动画帧，不使用隐藏首帧截图充当视觉通过。']}
(docs/'v1.4-验收结果.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'python':89,'node':35,'source_desktop':34,'packaged_desktop':34,'version':'1.4.0'},ensure_ascii=False))
