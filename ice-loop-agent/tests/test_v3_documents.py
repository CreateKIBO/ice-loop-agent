"""v3 普通文章（P0-A/B/C）后端回归：独立文章、版本与冲突、粘贴导入、交付、收藏、发布登记、执行退场。

全部使用 owned 临时夹具；不调用真实模型、不访问网络。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sqlite3
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image

from ice_agent.documents.html_import import convert_html
from ice_agent.documents.markdown_io import content_to_md, md_to_content
from ice_agent.documents.sanitize import sanitize_html
from ice_agent.documents.schema import DocumentError, normalize
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store
from ice_agent.domain.types import now_iso

from tests import REPO, temp_dir


def png_data_url(color=(200, 30, 30), size=(64, 40)) -> str:
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


def paragraph(text, **attrs):
    return {'type': 'paragraph', 'attrs': attrs, 'content': [{'type': 'text', 'text': text}]}


def doc(*blocks, style=None):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': list(blocks)}, 'style': style or {}}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-docs-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.service = SimpleNamespace(runtime=self.runtime)
        from ice_agent.creative_chat import initialize_chat
        initialize_chat(self.store)
        self.docs = DocumentService(self.service, self.store, {'id': 'acct-a'})

    def tearDown(self):
        self.store.close()


class TestSchemaAndMarkdown(unittest.TestCase):
    def test_normalize_rejects_unsafe_and_keeps_text(self):
        content = normalize(doc(
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': '链接', 'marks': [
                {'type': 'link', 'attrs': {'href': 'javascript:alert(1)'}}, {'type': 'textStyle', 'attrs': {'color': 'red', 'fontSize': '99px'}}]}]},
            {'type': 'mysteryWidget', 'content': [{'type': 'text', 'text': '未知模块的文字'}]}))
        first, second = content['doc']['content']
        self.assertNotIn('marks', first['content'][0])
        self.assertEqual(second['type'], 'rawBlock')
        self.assertEqual(second['attrs']['source'], '未知模块的文字')
        self.assertTrue(all(b['attrs']['id'] for b in content['doc']['content']))

    def test_style_validation(self):
        with self.assertRaises(DocumentError):
            normalize(doc(paragraph('x'), style={'fontSize': 30}))
        self.assertEqual(normalize(doc(paragraph('x'), style={'brandColor': '#AABBCC'}))['style']['brandColor'], '#aabbcc')

    def test_markdown_legacy_markers_roundtrip(self):
        src = ('# 标题\n\n正文 **粗**\n\n![图1：示意](待配图：生图｜见配图方案表)\n\n'
               '<!--RUN_OUTPUT:run-1-->\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
        content = md_to_content(src)
        kinds = [b['type'] for b in content['doc']['content']]
        self.assertEqual(kinds, ['heading', 'paragraph', 'imageSlot', 'runOutput', 'rawHtml'])
        projected = content_to_md(content)
        self.assertIn('![图1：示意](待配图：生图｜见配图方案表)', projected)
        self.assertIn('<!--RUN_OUTPUT:run-1-->', projected)
        self.assertEqual([b['type'] for b in md_to_content(projected)['doc']['content']], kinds)

    def test_sanitizer_strips_scripts_and_events(self):
        html, dropped = sanitize_html('<p onclick="x" style="color:red;background:url(evil)">a<script>bad()</script>'
                                      '<a href="javascript:x">b</a><img src="file:///etc/passwd"></p>')
        self.assertNotIn('script', html)
        self.assertNotIn('onclick', html)
        self.assertNotIn('url(', html)
        self.assertNotIn('javascript', html)
        self.assertNotIn('file:', html)
        self.assertEqual(dropped['script'], 1)


class TestPasteImport(Fixture):
    HTML = ('<section><h2 style="text-align:center">开场</h2><p>这是<strong>重点</strong>，'
            '<span style="color:rgb(255,0,0)">红字</span><br>第二行</p>'
            '<p><img src="https://mmbiz.qpic.cn/a.png" alt="远程图"></p>'
            '<p><img src="{data}" alt="本地图"></p>'
            '<section style="background-color:#eee;border:1px solid #ccc"><p>卡片</p></section>'
            '<table><tr><td>1</td></tr></table><script>steal()</script></section>')

    def test_adapt_report_lists_missing_images_islands_and_drops(self):
        html = self.HTML.format(data=png_data_url())
        result = self.docs.import_paste({'html': html, 'mode': 'adapt'})
        report = result['report']
        self.assertEqual(report['images']['total'], 2)
        self.assertEqual(report['images']['imported'], 1)
        self.assertEqual(report['images']['missing'][0]['src'], 'https://mmbiz.qpic.cn/a.png')
        self.assertEqual(len(report['islands']), 2)
        self.assertEqual(report['dropped'].get('script'), 1)
        kinds = [b['type'] for b in result['content']['doc']['content']]
        self.assertIn('articleImage', kinds)
        self.assertIn('imageSlot', kinds)
        self.assertIn('rawHtml', kinds)
        heading = result['content']['doc']['content'][0]
        self.assertEqual(heading['attrs']['textAlign'], 'center')
        self.assertIsNone(result['series'])
        self.assertIsNone(result['episode'])

    def test_text_only_reconvert_is_versioned_and_undoable(self):
        html = self.HTML.format(data=png_data_url())
        created = self.docs.import_paste({'html': html, 'mode': 'adapt'})
        adapted_hash = created['content_hash']
        converted = self.docs.reconvert({'document_id': created['document_id'], 'import_id': created['import_id'],
                                         'mode': 'text', 'base_revision': created['revision']})
        kinds = {b['type'] for b in converted['content']['doc']['content']}
        self.assertEqual(kinds, {'paragraph'})
        versions = self.docs.versions({'document_id': created['document_id']})
        self.assertEqual(versions[0]['producer'], 'convert')
        original = next(v for v in versions if v['content_hash'] == adapted_hash)
        restored = self.docs.restore({'document_id': created['document_id'], 'version_id': original['version_id'],
                                      'base_revision': converted['revision']})
        self.assertEqual(restored['content_hash'], adapted_hash)

    def test_convert_paste_keeps_original(self):
        result = self.docs.convert_paste({'html': '<p>a</p><svg><circle/></svg>', 'mode': 'adapt'})
        row = self.store.conn.execute('SELECT original FROM document_import_originals WHERE import_id=?',
                                      (result['import_id'],)).fetchone()
        self.assertIn('<svg>', row['original'])

    def test_plain_text_paste(self):
        result = self.docs.import_paste({'text': '第一段\n续行\n\n第二段'})
        blocks = result['content']['doc']['content']
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]['content'][1]['type'], 'hardBreak')

    def test_original_read_is_bound_to_account_and_document(self):
        original = '<p>原件<script>never run()</script></p>'
        imported = self.docs.import_paste({'html': original})
        params = {'document_id': imported['document_id'], 'import_id': imported['import_id']}
        self.assertEqual(self.docs.import_original(params)['original'], original)
        other = self.docs.create({'kind': 'blank'})
        with self.assertRaises(DocumentError):
            self.docs.import_original({**params, 'document_id': other['document_id']})
        with self.assertRaises(DocumentError):
            DocumentService(self.service, self.store, {'id': 'acct-b'}).import_original(params)

    def test_complex_module_images_are_reported_and_not_hotlinked(self):
        html = '<table><tr><td>说明<img src="https://example.com/unmanaged.png" alt="原件内图"></td></tr></table>'
        imported = self.docs.import_paste({'html': html})
        self.assertEqual(imported['report']['images']['total'], 1)
        self.assertEqual(len(imported['report']['images']['missing']), 1)
        rendered = self.docs.render_delivery({'document_id': imported['document_id'], 'base_revision': imported['revision']})
        self.assertFalse(rendered['complete'])
        self.assertNotIn('<img', rendered['html'])
        self.assertTrue(any(issue['kind'] == 'island_images' for issue in rendered['issues']))


class TestWorkingCopyAndVersions(Fixture):
    def test_title_only_change_is_frozen_for_delivery(self):
        created = self.docs.create({'kind': 'blank', 'title': '原题'})
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'],
                                        'content': created['content'], 'title': '新题'})
        current = self.docs.get({'document_id': created['document_id']})
        self.assertTrue(current['unversioned_changes'])
        delivered = self.docs.render_delivery({'document_id': created['document_id'], 'base_revision': saved['revision']})
        self.assertEqual(delivered['title'], '新题')
        self.assertNotEqual(delivered['version_id'], created['head_version_id'])

    def test_restore_preserves_title_only_change(self):
        created = self.docs.create({'kind': 'blank', 'title': '原题'})
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'],
                                        'content': created['content'], 'title': '未成版的新标题'})
        self.docs.restore({'document_id': created['document_id'], 'base_revision': saved['revision'],
                           'version_id': created['head_version_id']})
        self.assertIn('未成版的新标题', [v['title'] for v in self.docs.versions({'document_id': created['document_id']})])

    def test_manual_flow_without_job_or_series(self):
        created = self.docs.create({'kind': 'blank', 'title': '手动文章'})
        self.assertTrue(created['document_id'].startswith('doc-'))
        self.assertIsNone(created['series'])
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'],
                                        'content': doc(paragraph('第一版'))})
        self.assertEqual(saved['revision'], 2)
        current = self.docs.get({'document_id': created['document_id']})['content']  # 客户端回传带稳定块 id 的内容
        again = self.docs.save_working({'document_id': created['document_id'], 'base_revision': 2,
                                        'content': current})
        self.assertTrue(again['unchanged'])
        version = self.docs.commit_version({'document_id': created['document_id'], 'base_revision': 2, 'note': '定稿'})
        self.assertTrue(version['created'])
        reopened = self.docs.get({'document_id': created['document_id']})
        self.assertFalse(reopened['unversioned_changes'])
        self.assertEqual(reopened['content']['doc']['content'][0]['content'][0]['text'], '第一版')

    def test_conflict_preserves_both_sides(self):
        created = self.docs.create({'kind': 'blank'})
        self.docs.save_working({'document_id': created['document_id'], 'base_revision': 1, 'content': doc(paragraph('窗口A'))})
        stale = self.docs.save_working({'document_id': created['document_id'], 'base_revision': 1, 'content': doc(paragraph('窗口B'))})
        self.assertTrue(stale['conflict'])
        self.assertEqual(stale['server']['content']['doc']['content'][0]['content'][0]['text'], '窗口A')
        forced = self.docs.save_working({'document_id': created['document_id'], 'base_revision': 1, 'force': True,
                                         'content': doc(paragraph('窗口B'))})
        self.assertEqual(forced['revision'], 3)

    def test_restore_freezes_unversioned_changes_first(self):
        created = self.docs.create({'kind': 'blank'})
        first = self.docs.versions({'document_id': created['document_id']})[0]
        self.docs.save_working({'document_id': created['document_id'], 'base_revision': 1, 'content': doc(paragraph('未成版修改'))})
        self.docs.restore({'document_id': created['document_id'], 'version_id': first['version_id'], 'base_revision': 2})
        producers = [v['producer'] for v in self.docs.versions({'document_id': created['document_id']})]
        self.assertEqual(producers[:2], ['restore', 'autosave'])

    def test_account_isolation(self):
        created = self.docs.create({'kind': 'blank'})
        other = DocumentService(self.service, self.store, {'id': 'acct-b'})
        with self.assertRaises(DocumentError):
            other.get({'document_id': created['document_id']})
        self.assertEqual(other.list({})['documents'], [])

    def test_legacy_draft_maps_once_without_rewriting(self):
        draft = self.docs.assets.save_draft({'title': '旧草稿', 'body': '# 旧草稿\n\n旧正文'})
        listing = self.docs.list({})
        self.assertEqual([i['origin_ref'] for i in listing['legacy']], [draft['draft_id']])
        opened = self.docs.open_legacy({'origin': 'legacy_draft', 'origin_ref': draft['draft_id']})
        again = self.docs.open_legacy({'origin': 'legacy_draft', 'origin_ref': draft['draft_id']})
        self.assertEqual(opened['document_id'], again['document_id'])
        self.assertEqual(self.docs.list({})['legacy'], [])
        self.assertEqual(self.docs.assets.draft(draft['draft_id'])['body'], '# 旧草稿\n\n旧正文')


class TestDeliveryAndPublication(Fixture):
    def _with_image(self):
        image = self.docs.image_import_data({'data_url': png_data_url(), 'name': '示意图'})
        created = self.docs.create({'kind': 'blank', 'title': '图文稿'})
        content = doc({'type': 'heading', 'attrs': {'level': 2}, 'content': [{'type': 'text', 'text': '小标题'}]},
                      paragraph('正文段落'),
                      {'type': 'articleImage', 'attrs': {'resourceId': image['resource_id'], 'caption': '图注一', 'width': 80}},
                      paragraph('结尾', textAlign='center'),
                      style={'brandColor': '#0f766e', 'fontSize': 15, 'lineHeight': 1.8, 'paragraphSpacing': 20})
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': 1, 'content': content})
        return created['document_id'], saved['revision'], image

    def test_render_html_text_and_images_share_order(self):
        document_id, revision, image = self._with_image()
        rendered = self.docs.render_delivery({'document_id': document_id, 'base_revision': revision})
        self.assertTrue(rendered['complete'])
        self.assertIn('font-size:15px', rendered['html'])
        self.assertIn('#0f766e', rendered['html'])
        self.assertIn('data-ice-order="1"', rendered['html'])
        self.assertIn('【图1：图注一】', rendered['text'])
        self.assertEqual(rendered['images'][0]['resource_id'], image['resource_id'])
        self.assertEqual(rendered['images'][0]['file_name'], '01-图注一.png')
        # 交付冻结了一个版本；再次渲染同一内容不产生新版本
        again = self.docs.render_delivery({'document_id': document_id, 'base_revision': revision})
        self.assertEqual(again['version_id'], rendered['version_id'])
        self.assertEqual(again['delivery_hash'], rendered['delivery_hash'])

    def test_missing_image_is_not_complete(self):
        created = self.docs.create({'kind': 'blank'})
        content = doc(paragraph('x'), {'type': 'imageSlot', 'attrs': {'figureNo': 1, 'caption': '缺图'}})
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': 1, 'content': content})
        rendered = self.docs.render_delivery({'document_id': created['document_id'], 'base_revision': saved['revision']})
        self.assertFalse(rendered['complete'])
        self.assertEqual(rendered['issues'][0]['kind'], 'image_missing')

    def test_reused_resource_preserves_each_image_number_in_bundle(self):
        document_id, revision, _ = self._with_image()
        current = self.docs.get({'document_id': document_id})
        image = next(b for b in current['content']['doc']['content'] if b['type'] == 'articleImage')
        second = json.loads(json.dumps(image))
        second['attrs'].pop('id')
        second['attrs']['caption'] = '图注二'
        current['content']['doc']['content'].append(second)
        saved = self.docs.save_working({'document_id': document_id, 'base_revision': revision, 'content': current['content']})
        target = self.root / 'repeated-image-export'
        self.docs.export_bundle({'document_id': document_id, 'base_revision': saved['revision'], 'destination': str(target)})
        html = (target / '正文预览.html').read_text(encoding='utf-8')
        first = html.index('图片/01-图注一.png')
        second = html.index('图片/02-图注二.png')
        self.assertLess(first, second)

    def test_export_bundle_and_publication_binding(self):
        document_id, revision, _ = self._with_image()
        version_id = self.docs.render_delivery({'document_id': document_id, 'base_revision': revision})['version_id']
        with self.assertRaises(DocumentError):  # 未交付不能登记发布
            self.docs.register_publication({'document_id': document_id, 'version_id': version_id})
        target = self.root / 'exports' / 'bundle'
        result = self.docs.export_bundle({'document_id': document_id, 'version_id': version_id, 'destination': str(target)})
        self.assertEqual(result['images'], 1)
        manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version_id'], version_id)
        self.assertIn('导出不等于已发布', manifest['note'])
        self.assertTrue((target / '图片' / '01-图注一.png').is_file())
        self.assertIn('图片/01-图注一.png', (target / '正文预览.html').read_text(encoding='utf-8'))
        self.assertEqual(self.docs.publications({'document_id': document_id}), [])
        record = self.docs.register_publication({'document_id': document_id, 'version_id': version_id,
                                                 'url': 'https://mp.weixin.qq.com/s/abc', 'note': '首发'})
        self.assertEqual(record['source'], 'user_registered')
        self.assertEqual(record['delivery_id'], result['delivery_id'])
        # 发布后继续改稿：不回写已发布版本
        self.docs.save_working({'document_id': document_id, 'base_revision': revision, 'content': doc(paragraph('改稿'))})
        published = [v for v in self.docs.versions({'document_id': document_id}) if v['published']]
        self.assertEqual([v['version_id'] for v in published], [version_id])
        with self.assertRaises(ValueError):
            self.docs.export_bundle({'document_id': document_id, 'version_id': version_id, 'destination': str(target)})


class TestBookmarks(Fixture):
    def test_defaults_per_account_and_deletable(self):
        items = self.docs.bookmarks({})
        self.assertEqual([b['title'] for b in items], ['微信公众平台', 'TapNow'])
        self.docs.bookmark_remove({'bookmark_id': items[1]['bookmark_id']})
        self.assertEqual(len(self.docs.bookmarks({})), 1)  # 删除的默认项不会被重新播种
        saved = self.docs.bookmark_save({'url': 'example.com/path', 'title': '示例'})
        self.assertEqual(saved['url'], 'https://example.com/path')
        with self.assertRaises(DocumentError):
            self.docs.bookmark_save({'url': 'http://insecure.example'})
        with self.assertRaises(DocumentError):
            self.docs.bookmark_save({'url': 'https://user:pw@example.com'})
        other = DocumentService(self.service, self.store, {'id': 'acct-b'})
        self.assertEqual(len(other.bookmarks({})), 2)
        restored = self.docs.bookmark_restore_defaults({})
        self.assertEqual(len(restored), 3)


class TestAiDraftReconcile(Fixture):
    def test_request_replay_reuses_document_and_checks_brief(self):
        params = {'brief': '写一篇家庭收纳的文章', 'request_id': 'owned-ai-request'}
        first = self.docs.ai_draft_start(params)
        second = self.docs.ai_draft_start(params)
        self.assertEqual(first['document']['document_id'], second['document']['document_id'])
        self.assertTrue(first['created'])
        self.assertFalse(second['created'])
        with self.assertRaises(DocumentError):
            self.docs.ai_draft_start({**params, 'brief': '另一份完全不同的需求'})

    def test_list_during_start_does_not_mark_pending_request_failed(self):
        started = self.docs.ai_draft_start({'brief': '写一篇家庭收纳的文章'})
        document_id = started['document']['document_id']
        self.assertEqual(self.docs.get({'document_id': document_id})['generation_state'], 'running')

    def _message(self, status, metadata):
        mid = 'msg-' + os.urandom(4).hex()
        self.store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                                (mid, 'conversation-x', 'assistant', '', status, json.dumps(metadata), now_iso()))
        self.store.conn.commit()
        return mid

    def _start(self, mid):
        started = self.docs.ai_draft_start({'brief': '写一篇关于家庭收纳的文章'})
        document_id = started['document']['document_id']
        self.docs.ai_draft_bind(document_id, 'conversation-x', mid, None)
        return document_id

    def test_success_saves_independent_ai_draft(self):
        self.store.conn.execute('INSERT INTO creative_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                ('candidate-1', 'conversation-x', 'acct-a', '收纳指南', '# 收纳指南\n\n第一段',
                                 '{}', '[]', 'draft', None, '{}', now_iso()))
        mid = self._message('completed', {'candidate_id': 'candidate-1'})
        document_id = self._start(mid)
        item = next(d for d in self.docs.list({})['documents'] if d['document_id'] == document_id)
        self.assertEqual(item['generation_state'], 'ready')
        document = self.docs.get({'document_id': document_id})
        self.assertEqual(document['title'], '收纳指南')
        self.assertEqual(document['head_version']['producer'], 'ai')

    def test_failure_is_not_presented_as_complete(self):
        mid = self._message('failed', {'error_message': '模型超时'})
        document_id = self._start(mid)
        document = self.docs.get({'document_id': document_id})
        self.assertEqual(document['generation_state'], 'failed')
        self.assertEqual(document['meta']['error'], '模型超时')
        self.assertIsNone(document['head_version_id'])

    def test_user_edits_during_generation_are_never_overwritten(self):
        self.store.conn.execute('INSERT INTO creative_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                ('candidate-2', 'conversation-x', 'acct-a', '生成稿', '# 生成稿\n\n内容',
                                 '{}', '[]', 'draft', None, '{}', now_iso()))
        mid = self._message('streaming', {})
        document_id = self._start(mid)
        self.docs.save_working({'document_id': document_id, 'base_revision': 1, 'content': doc(paragraph('我自己写的'))})
        self.store.conn.execute("UPDATE creative_messages SET status='completed', metadata_json=? WHERE id=?",
                                (json.dumps({'candidate_id': 'candidate-2'}), mid))
        self.store.conn.commit()
        documents = self.docs.list({})['documents']
        mine = self.docs.get({'document_id': document_id})
        self.assertEqual(mine['content']['doc']['content'][0]['content'][0]['text'], '我自己写的')
        self.assertTrue(any(d['title'] == '生成稿（AI 初稿）' for d in documents))


class TestDesktopRetirement(unittest.TestCase):
    def setUp(self):
        from ice_agent.desktop_service import DesktopService
        self.root = temp_dir('v3-retire-')
        self.env = mock.patch.dict(os.environ, {'ICE_LEGACY_CODE_EXECUTION': '0'})
        self.env.start()
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')

    def tearDown(self):
        self.service.close()
        self.env.stop()

    def test_execution_rpcs_rejected_by_default(self):
        self.assertTrue(self.service.code_execution_retired)
        for method in ('execution.approve', 'execution.inputs', 'execution.code_save', 'execution.policy_save',
                       'supplements.execute', 'assets.capture_context', 'assets.capture_finish'):
            with self.assertRaisesRegex(ValueError, 'CODE_EXECUTION_RETIRED'):
                self.service.call(method, {'job_id': 'job-x'})

    def test_packaged_build_ignores_legacy_switch(self):
        with mock.patch.dict(os.environ, {'ICE_LEGACY_CODE_EXECUTION': '1', 'ICE_PACKAGED': '1'}):
            self.assertTrue(self.service.code_execution_retired)

    def test_app_runner_and_cfg_are_retired(self):
        engine, cfg, store = self.service._app()
        try:
            self.assertTrue(cfg.code_execution_retired)
            self.assertFalse(engine.runner.allow_local_reviewed)
        finally:
            store.close()

    def test_documents_rpc_works_without_models(self):
        created = self.service.call('documents.create', {'kind': 'blank', 'title': '无模型手动稿'})
        listing = self.service.call('documents.list', {})
        self.assertEqual(listing['documents'][0]['document_id'], created['document_id'])
        self.assertEqual(self.service.call('bookmarks.list', {})[0]['url'], 'https://mp.weixin.qq.com/')

    def test_verify_code_retired_fails_honestly_and_reuses_history(self):
        from ice_agent.workflow import nodes
        block = {'index': 1, 'language': 'python', 'code_sha256': 'h', 'stdin_hash': 's', 'expected_failure': False}
        ctx = SimpleNamespace(cfg=SimpleNamespace(code_execution_retired=True), state={'spec': {}, 'runs': {}},
                              emit=lambda *a, **k: None)
        with mock.patch('ice_agent.execution.plan.execution_plan', return_value={'blocks': [block]}):
            with self.assertRaises(nodes.NodeFailed) as raised:
                nodes.node_verify_code(ctx)
        self.assertIn('复制为新文章', str(raised.exception))
        old_runs = {'run-1': {'source': 'historical code', 'stdout': 'historical output'}}
        ctx.state['runs'] = old_runs
        with mock.patch('ice_agent.execution.plan.execution_plan', return_value={'blocks': [block]}), \
             mock.patch.object(nodes, '_cached_run_valid', return_value=True):
            with self.assertRaises(nodes.NodeFailed):
                nodes.node_verify_code(ctx)
        self.assertIs(ctx.state['runs'], old_runs)  # 历史有效也不继续执行或改写旧 state
        with mock.patch('ice_agent.execution.plan.execution_plan', return_value={'blocks': []}):
            self.assertEqual(nodes.node_verify_code(ctx)['runs'], 0)


class TestMigration(unittest.TestCase):
    def test_v23_creates_tables(self):
        root = temp_dir('v3-mig-')
        store = Store(root / 'app.db')
        try:
            tables = {r[0] for r in store.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in ('documents', 'document_working', 'document_versions', 'document_import_originals',
                          'document_deliveries', 'bookmarks', 'publication_records'):
                self.assertIn(table, tables)
            self.assertEqual(store.conn.execute('PRAGMA user_version').fetchone()[0], 23)
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()


class TestClarificationQuestions(unittest.TestCase):
    """v3.1：助手提问框——选项说明、短标签、多选；纯文本旧格式保持原样。"""
    def test_rich_options_are_normalized(self):
        from ice_agent.creative_chat import CreativeChat
        result = CreativeChat._questions({'questions': [
            {'id': 'reader', 'question': '面向什么读者？', 'header': '读者对象超长标签会被截断',
             'options': [{'label': '零基础（推荐）', 'description': '多用类比'}, '已有基础']},
            {'id': 'parts', 'question': '包含哪些部分？', 'multiple': True, 'options': ['案例', '清单', '常见误区']},
            {'id': 'tone', 'question': '语气？', 'options': ['轻松', '冷静']},
            {'id': 'extra', 'question': '还有补充吗？'}]})
        self.assertEqual(result[0]['options'], ['零基础（推荐）', '已有基础'])
        self.assertEqual(result[0]['details'], ['多用类比', ''])
        self.assertEqual(result[0]['header'], '读者对象超长标签会被截断'[:12])
        self.assertTrue(result[1]['multiple'])
        self.assertEqual(result[2], {'id': 'tone', 'question': '语气？', 'options': ['轻松', '冷静']})
        self.assertEqual(result[3]['options'], [])

    def test_invalid_questions_rejected(self):
        from ice_agent.creative_chat import CreativeChat
        with self.assertRaises(ValueError):
            CreativeChat._questions({'questions': [{'id': f'q{i}', 'question': '?'} for i in range(5)]})
        with self.assertRaises(ValueError):
            CreativeChat._questions({'questions': [{'id': 'a', 'question': '?', 'options': [{'label': ''}]}]})
        with self.assertRaises(ValueError):
            CreativeChat._questions({'questions': [{'id': 'a', 'question': '?', 'options': ['同', {'label': '同'}]}]})
