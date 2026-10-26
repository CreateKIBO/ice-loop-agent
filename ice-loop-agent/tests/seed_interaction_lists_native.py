"""Owned fixture for keyboard/list interaction acceptance; two accounts, offline only.

Data is created through the real DesktopService RPC layer (chat.create / accounts.save)
plus a direct candidate row and real engine-created job checkpoints, following the
seed_glm_review_native precedent. No cloud credentials, no personal data.

The generated entry wrapper:
- cancels all external http(s) requests;
- logs settled ice:request to requests.jsonl (method/account/ok) for real
  write-count assertions;
- reads fault-control.json before each request: {"fail":["method"],"delayMs":
  {"method":ms},"errorMessage":"..."} to inject read faults/delays (test-owned file);
- logs successful browser invokes with post-handler WebContents ids;
- traces start/resolve/reject for every handler in invocations.jsonl (no payloads).
"""
import json, os, sys
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_json
from ice_agent.domain.store import Store
from ice_agent.llm.capabilities import preset_profile
from ice_agent.paths import atomic_write_text

root = repo / '.test-tmp/release-interaction-lists' / uuid4().hex[:12]
runtime = root / 'runtime'
runtime.mkdir(parents=True)
atomic_write_text(root / '.test-owner.json', '{"purpose":"keyboard list interaction acceptance"}')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
service = DesktopService(repo, runtime, root / 'articles', auto_consumer=False)
try:
    account_a = service._account()['id']
    conversations = []
    for index in range(1, 5):
        conversations.append(service.call('chat.create', {'title': f'键盘验收会话{index}'})['conversation']['id'])
    # Second account via real RPC; then switch back to A so the UI starts on A.
    first = service._account()
    service.accounts_save({'account': {**first, 'library_root': ''}})
    account_b_data = {key: value for key, value in first.items() if key != 'id'}
    account_b_data.update(preset='general', name='键盘验收B号', audience='验收用', library_root='',
                          article_root=str(root / 'b-articles'), columns=[{'code': 'PY', 'name': '验收栏目'}])
    account_b = service.accounts_save({'account': account_b_data})['saved_account_id']
    service.call('chat.create', {'title': 'B号独占会话'})
    service.call('accounts.switch', {'account_id': account_a})

    store = Store(runtime / 'app.db')
    try:
        # A real, saveable draft candidate on conversation 1: base points at a
        # publication_drafts row so chat.save_draft / chat.submit run the true path.
        draft_id = 'draft-' + uuid4().hex[:10]
        draft_body = '# 键盘验收候选稿\n\n真实保存链路的合成正文。'
        # content_hash 与 WorkspaceAssets.save_draft 的算法一致，保证 _check_base 通过。
        draft_hash = sha256_json({'title': '键盘验收候选稿', 'body': draft_body})
        store.conn.execute('INSERT INTO publication_drafts VALUES (?,?,?,?,?,?)',
                           (draft_id, account_a, '键盘验收候选稿', draft_body, draft_hash, '2026-10-20T00:00:00Z'))
        store.conn.execute('UPDATE creative_conversations SET target_json=? WHERE id=?',
                           (json.dumps({'type': 'draft', 'id': draft_id}, ensure_ascii=False), conversations[0]))
        store.conn.execute('INSERT INTO creative_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                           ('cand-keyboard-1', conversations[0], account_a, '键盘验收候选稿', draft_body,
                            json.dumps({'type': 'draft', 'id': draft_id, 'content_hash': draft_hash}, ensure_ascii=False),
                            '[]', 'draft', None, '{}', '2026-10-20T00:00:00Z'))
        store.conn.commit()
    finally:
        store.close()

    # Real engine creation supplies checkpoints, route snapshots and a usable document.
    # Stable fixture IDs keep the existing UI tests readable; only ID allocation is mocked.
    from unittest.mock import patch
    from tests.test_workflow import demo_spec
    from PIL import Image
    engine, _, job_store = service._app(demo=True)
    try:
        for label, title in [('done', '已完成的验收稿'), ('paused', '暂停中的验收稿'), ('running', '进行中的验收稿')]:
            job_id, article_id = 'job-kb-' + label, 'art-kb-' + label
            spec = {**demo_spec(), 'demo': True, 'account_id': account_a, 'topic': title}
            with patch('ice_agent.workflow.engine.new_id', side_effect=[job_id, article_id]):
                engine.create_job(spec)
            if label == 'done':
                result = engine.run(job_id, auto_approver=lambda scope, payload: ('approve', 'offline fixture', None))
                assert result['state'] == 'completed', result
                job_store.update_article(article_id, final_title=title)
                cover = next(row for row in job_store.article_slots(article_id) if row['kind'] == 'cover')
                image = root / 'viewer-original.png'
                Image.new('RGB', (2400, 1400), '#2448DB').save(image)
                selected = engine.import_asset(job_id, cover['figure_no'], image, accept=True)
                alternate = root / 'viewer-alternate.png'
                Image.new('RGB', (1800, 1100), '#F3F2ED').save(alternate)
                pending = engine.import_asset(job_id, cover['figure_no'], alternate, accept=False)
                asset_fixture = {'figure': cover['figure_no'], 'selected': selected['candidate_id'], 'pending': pending['candidate_id']}
            else:
                result = engine.run(job_id)
                assert result['state'] == 'awaiting_approval', result
                job_store.update_job(job_id, state='paused', pause_reason='隔离夹具等待显式续跑')
    finally:
        job_store.close()

    # Explicitly offline model profile so readiness is stable during UI checks.
    profile = preset_profile('mock', profile_id='keyboard-offline-fixture')
    profile.update(api_key_env='ICE_KEYBOARD_FAKE_KEY', status='verified', model_id='offline-keyboard-only')
    service.settings['profiles'] = {'offline': profile}
    for route in service.settings['routes'].values():
        route.update(primary=profile['profile_id'], fallbacks=[])

    # 2026-10-22 批D：经真实 downloads.stage RPC 把两张离线 PNG 放入待归档箱
    # （与浏览器下载同一条后端链路：magic 校验、sha256 去重、pending 状态）。
    download_fixture = {}
    for label, color, size in [('bind', '#3AA675', (1200, 700)), ('discard', '#B8860B', (900, 600))]:
        staged = root / f'download-{label}.png'
        Image.new('RGB', size, color).save(staged)
        staged_result = service.call('downloads.stage', {'file_path': str(staged)})
        download_fixture[label] = {'download_id': staged_result['download_id'], 'file_path': str(staged)}
    atomic_write_text(service.settings_file, json.dumps(service.settings, ensure_ascii=False, indent=2))

    observed = root / 'requests.jsonl'
    fault = root / 'fault-control.json'
    fault.write_text('{}', encoding='utf-8')
    entry = root / 'keyboard-main.cjs'
    trace = root / 'invocations.jsonl'
    entry.write_text(
        "const {app,ipcMain,BrowserWindow}=require('electron');"
        "app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));"
        f"require({json.dumps(str(repo / 'desktop/tests/ipc-observer.cjs'))}).observeIpc({{"
        f"ipcMain,BrowserWindow,observed:{json.dumps(str(observed))},"
        f"trace:{json.dumps(str(trace))},fault:{json.dumps(str(fault))}}});"
        f"require({json.dumps(str(repo / 'desktop/main.cjs'))});", encoding='utf-8')
    fixture = {'root': str(root), 'runtime': str(runtime), 'entry': str(entry), 'observed': str(observed),
               'fault': str(fault), 'trace': str(trace), 'account_a': account_a, 'account_b': account_b,
               'conversations': conversations, 'candidate': 'cand-keyboard-1', 'draft_id': draft_id,
               'assets': asset_fixture, 'downloads': download_fixture,
               'jobs': {'completed': 'job-kb-done', 'paused': 'job-kb-paused', 'running': 'job-kb-running'}}
    path = repo / 'docs/上线准备/interaction-lists-fixture.json'
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(fixture, ensure_ascii=False))
finally:
    service.close()
