"""独立复现：全部文件/数据库在本轮G盘owner目录，输出真实观察而非伪造测试通过。"""
from __future__ import annotations
import hashlib
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

# 本次仅离线验收：移除全部非必要环境变量（包括任何供应商Key），并让
# 所有socket连接/urllib opener尝试在发包前失败。不是授权真实能力探测。
safe_env = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'TEMP', 'TMP') if key in os.environ}
safe_env['PYTHONUTF8'] = '1'
os.environ.clear()
os.environ.update(safe_env)
offline_socket_guard = patch('socket.socket.connect', side_effect=RuntimeError('OFFLINE_REVIEW_NETWORK_DISABLED'))
offline_http_guard = patch('urllib.request.OpenerDirector.open', side_effect=RuntimeError('OFFLINE_REVIEW_NETWORK_DISABLED'))
offline_socket_guard.start()
offline_http_guard.start()

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.export.bundle import export_bundle
from ice_agent.domain.types import sha256_text
from ice_agent.tasks import TaskQueue
from PIL import Image
from tests.test_workflow import demo_spec

root = repo / '.test-tmp' / 'review-20261008' / 'backend-repro'
root.mkdir(parents=True, exist_ok=True)
service = DesktopService(repo, root / 'runtime', root / 'articles')
engine, _, store = service._app(demo=True)
observations = {}
try:
    job, article = engine.create_job({**demo_spec(), 'demo': True, 'account_id': 'ice-loop', 'article_root': str(root / 'articles')})
    body = '# 验收文章\n\n![图1：封面](待配图：封面｜测试资源)\n'
    state = engine._load_state(job)
    state.update(integrated_md=body, draft_md=body)
    engine._save_state(job, state)
    store.update_job(job, state='completed', current_node='export')
    source = root / 'resource.jpg'
    Image.new('RGB', (640, 320), 'blue').save(source, 'JPEG')
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    slot = {'slot_id': 'review-slot', 'article_id': article, 'figure_no': 1, 'prompt_no': 1, 'kind': 'cover_ai', 'selected_candidate': 'review-candidate'}
    store.upsert_slot(slot)
    store.add_candidate({'candidate_id': 'review-candidate', 'slot_id': 'review-slot', 'source': 'review-fixture', 'file_path': str(source), 'sha256': sha, 'review_status': 'accepted'})
    view = service.call('jobs.get', {'job_id': job})
    result = service.call('articles.export_bundle', {'job_id': job, 'destination': str(root / 'actual-rpc-export'), 'mode': 'draft'})
    observations['export_real_selected_asset'] = {
        'jobs_get_valid': view['slots'][0]['valid'],
        'jobs_get_has_candidate_field': 'candidate' in view['slots'][0],
        'export_images': result['images'],
        'missing_images': result['checks']['missing_images'],
        'selected_image_omitted': view['slots'][0]['valid'] and result['images'] == 0
    }
    patched_shape = [{**view['slots'][0], 'candidate': store.get_candidate('review-candidate')}]
    direct = export_bundle(job_id=job, title='测试', body=body, content_hash=sha256_text(body),
                           slots=patched_shape, runs={}, destination=root / 'direct-export', mode='draft')
    exported_md = (root / 'direct-export/文本/01-公众号正文.md').read_text(encoding='utf-8')
    image_target = next((root / 'direct-export/图片').iterdir())
    observations['export_path_and_mime'] = {
        'copied_images': direct['images'], 'body_placeholder_preserved': '待配图：' in exported_md,
        'body_refs_exported_image': '../图片/' in exported_md,
        'file_extension': image_target.suffix, 'real_image_format': Image.open(image_target).format
    }
    plain = '# 未审阅稿\n\n宣称某模型免费额度为100次，没有核验记录。\n'
    state = engine._load_state(job); state.update(integrated_md=plain, draft_md=plain); engine._save_state(job, state)
    # 去图位以单独测事实/审批阻断；只操作本轮fixture。
    store.conn.execute('DELETE FROM asset_candidates WHERE candidate_id=?', ('review-candidate',))
    store.conn.execute('DELETE FROM asset_slots WHERE slot_id=?', ('review-slot',))
    store.conn.commit()
    store.add_claim({'claim_id': 'review-unverified-claim', 'article_id': article, 'text': '免费额度100次', 'risk_type': 'quota', 'status': 'needs_check'})
    ready = service.call('articles.export_bundle', {'job_id': job, 'destination': str(root / 'ready-with-unverified'), 'mode': 'ready'})
    observations['ready_export_missing_review_gate'] = {'accepted_mode': ready['mode'], 'unverified_claims': len(store.article_claims(article)), 'accepted_unverified_ready': ready['mode'] == 'ready'}
    provider = next(iter(service.settings['profiles']))
    try:
        service.call('models.probe_capabilities', {'provider': provider, 'aspects': ['tools']})
        observations['capability_probe'] = {'raised': False}
    except Exception as exc:
        observations['capability_probe'] = {'raised': True, 'type': type(exc).__name__, 'message': str(exc)}
    instant = '2026-10-08T12:34:56+00:00'
    destination = root / 'collision-export'
    staging = root / (destination.name + '-staging-' + instant.replace(':', '')[:14])
    staging.mkdir()
    sentinel = staging / 'preexisting-unowned-sentinel.txt'
    sentinel.write_text('fixture sentinel: this directory predates export', encoding='utf-8')
    collision_error = ''
    with patch('ice_agent.export.bundle.now_iso', return_value=instant):
        try:
            export_bundle(job_id=job, title='测试', body='# 测试\n', content_hash='test', slots=[], runs={}, destination=destination)
        except Exception as exc:
            collision_error = type(exc).__name__
    observations['export_cleanup_ownership'] = {'exception': collision_error, 'preexisting_dir_survives': staging.exists(), 'sentinel_survives': sentinel.exists(), 'unowned_fixture_deleted': not sentinel.exists()}
    queue = TaskQueue(store)
    first = queue.enqueue('account-a', 'article-production', {'episode': 1}, idempotency_key='same-client-key')
    second = queue.enqueue('account-b', 'article-production', {'episode': 99}, idempotency_key='same-client-key')
    observations['queue_idempotency_account_scope'] = {
        'first_account': first['account_id'], 'second_returned_account': second['account_id'],
        'same_task_id': first['task_id'] == second['task_id'],
        'wrong_account_returned': second['account_id'] != 'account-b'
    }
    same = queue.enqueue('account-a', 'article-production', {'episode': 2}, idempotency_key='same-client-key')
    observations['queue_idempotency_changed_input'] = {'changed_input_silently_reused': same['task_id'] == first['task_id'], 'returned_payload': same['payload']}
    blank = engine.create_job({**demo_spec(), 'demo': True, 'account_id': 'ice-loop', 'article_root': str(root / 'articles')})[0]
    try:
        service.call('articles.propose_patch', {'job_id': blank, 'base_revision': 'current', 'ops': [{'op': 'insert_after', 'block_id': 'new', 'new_block': {'type': 'paragraph', 'text': '初稿'}}]})
    except Exception as exc:
        observations['initial_draft_patch'] = {'type': type(exc).__name__, 'message': str(exc)}
finally:
    store.close()
    service.close()
result = {'scope': 'local isolated reproduction, no paid cloud requests', 'observations': observations}
(repo / 'docs/验收-2026-10-08/backend-repro-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
