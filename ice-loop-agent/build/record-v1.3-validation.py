"""Collect completed v1.3 checks without promoting partial observations to passes."""
import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
docs = root / 'docs'
parser = argparse.ArgumentParser()
parser.add_argument('--tapnow-visual-verified', action='store_true')
args = parser.parse_args()


def read(name):
    return (docs / name).read_text(encoding='utf-8-sig', errors='replace')


def data(name):
    return json.loads(read(name))


logs = ['v1.3-python-regression.log', 'v1.3-chat-final.log', 'v1.3-article-regression.log']
identifiers = set()
for log in logs:
    text = read(log)
    assert text.rstrip().endswith('OK'), log
    # unittest places a test docstring on the next line before "... ok".
    # The suite-level OK above verifies outcomes; collect IDs independently.
    identifiers.update(re.findall(r'^test_.*? \(([^)]+)\)', text, re.M))
assert len(identifiers) == 74, len(identifiers)
assert 'pass 35' in read('v1.3-node.log') and 'fail 0' in read('v1.3-node.log')
chat = data('v1.3-chat-desktop-packaged.log')
chat_flags = {k: v for k, v in chat.items() if isinstance(v, bool)}
assert len(chat_flags) == 17 and all(chat_flags.values())
desktop = data('v1.3-desktop-packaged.log')
assert desktop['completed'] and desktop['exported'] and desktop['runs'] == 3
assert all(desktop['publicationExport'][k] for k in ['twoFolders', 'markdown', 'imagesOnly', 'linksResolved', 'archiveSeparate', 'manualInstructions'])
browser = data('v1.3-browser-packaged.log')
assert browser['tapnowRouteInside'] and browser['downloadSaved'] and browser['persistentCookieAfterViewRecreate']
source = data('v1.3-package-source-audit.json')
binary = data('v1.3-package-binary-audit.json')
assert source['renderer_matches_source'] and binary['setup_payload_matches_unpacked'] and binary['zip_matches_unpacked']
live = data('v1.3-tapnow-live.json')
result = {
    'version': '1.3.0',
    'recorded_at': datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).isoformat(),
    'python': {'passed_unique_related_tests': len(identifiers), 'logs': logs,
               'groups': {'creative_chat': 11, 'history_planning': 12, 'router': 13, 'publication_supplements_workbench': 38}},
    'node': {'passed': 35, 'failed': 0, 'log': 'v1.3-node.log'},
    'packaged_chat': {'passed': 17, 'result': chat},
    'packaged_original_workflow': {'driver_passed': True, 'result': desktop},
    'packaged_browser': {'driver_passed': True, 'result': browser},
    'tapnow_live_observation': live,
    'tapnow_homepage_visually_verified': args.tapnow_visual_verified,
    'release_source': source,
    'release_binaries': binary,
    'boundaries': {
        'paid_model_calls_performed': False,
        'model_integration_used_isolated_offline_fixtures': True,
        'tapnow_login_or_generation_performed': False,
        'wechat_login_or_publication_performed': False,
        'actual_user_installation_or_workspace_modified': False,
        'installer_shutdown_restore_logic_reused_from_prior_verified_version': True,
        'installed_into_actual_user_directory_this_turn': False,
        'temporary_G_pyshot_tmp_used': False,
    },
    'notes': [
        '源码阶段的并发打包等待超时不作为通过记录；最终程序17项工作台及完整制作流程复验通过。',
        '已修复存稿入口重复插入造成的刷新循环，空闲对话降低目录刷新频率。',
        'Windows多层ASAR路径校验改用原生分隔符；ZIP缓存复用被内容校验发现后重新生成。',
        '第三方网站的DOM/title观察与视觉验证分开记录，登录、生图及正式发布仍由用户完成。',
        '仅旧生成测试构建移至E盘归档保留，正式文章、资源及实际安装工作区未迁移或删除。',
    ],
}
(docs / 'v1.3-验收结果.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'python': 74, 'node': 35, 'chat': 17, 'original_workflow': True,
                  'browser': True, 'tapnow_visual_verified': args.tapnow_visual_verified}, ensure_ascii=False))
