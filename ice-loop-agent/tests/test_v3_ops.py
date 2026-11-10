"""v3 P2 运营增强：批量整理、计划日期与发布日历、跨文章建议管理、素材标签。"""
from __future__ import annotations

import base64
import io
import unittest
from types import SimpleNamespace

from PIL import Image

from ice_agent.documents.assist import DocumentAssist
from ice_agent.documents.ops import DocumentOps
from ice_agent.documents.schema import DocumentError
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


def doc(text):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': [
        {'type': 'paragraph', 'attrs': {'id': 'b0000000001'}, 'content': [{'type': 'text', 'text': text}]}]}, 'style': {}}


class Fake:
    json = {'edits': [{'block_id': 'b0000000001', 'markdown': '改写后'}]}
    model_id = 'm'
    usage = {}


class TestOps(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-ops-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.service = SimpleNamespace(runtime=self.runtime)
        self.account = {'id': 'acct-a'}
        self.docs = DocumentService(self.service, self.store, self.account)
        self.ops = DocumentOps(self.service, self.store, self.account)

    def tearDown(self):
        self.store.close()

    def make(self, title, text='正文'):
        created = self.docs.create({'kind': 'blank', 'title': title})
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'], 'content': doc(text)})
        return created['document_id'], saved['revision']

    def test_batch_is_atomic_and_scoped(self):
        a, _ = self.make('甲')
        b, _ = self.make('乙')
        result = self.ops.batch({'action': 'set_series', 'document_ids': [a, b], 'series': '编译器笔记'})
        self.assertEqual(result['changed'], [a, b])
        rows = {r['document_id']: r for r in self.docs.list({})['documents']}
        self.assertEqual(rows[a]['series'], '编译器笔记')
        other = DocumentService(self.service, self.store, {'id': 'acct-b'}).create({'kind': 'blank', 'title': '别的号'})
        with self.assertRaises(DocumentError):
            self.ops.batch({'action': 'trash', 'document_ids': [a, other['document_id']]})
        self.assertEqual(self.docs.list({})['documents'][0]['lifecycle'], 'active')  # 整批回滚
        self.ops.batch({'action': 'trash', 'document_ids': [a, b]})
        self.assertEqual(self.docs.list({})['documents'], [])
        again = self.ops.batch({'action': 'trash', 'document_ids': [a]})
        self.assertEqual(again['skipped'], [a])
        self.ops.batch({'action': 'untrash', 'document_ids': [a, b]})
        self.ops.batch({'action': 'clear_series', 'document_ids': [a]})
        self.assertIsNone({r['document_id']: r for r in self.docs.list({})['documents']}[a]['series'])
        for bad in ({'action': 'delete', 'document_ids': [a]}, {'action': 'trash', 'document_ids': []},
                    {'action': 'set_series', 'document_ids': [a], 'series': ' '}, {'action': 'set_planned', 'document_ids': [a], 'planned_date': '2026-13-01'}):
            with self.assertRaises(DocumentError):
                self.ops.batch(bad)

    def test_calendar_plans_and_publications(self):
        a, rev = self.make('计划稿')
        b, rev_b = self.make('已发稿')
        self.ops.plan({'document_id': a, 'planned_date': '2026-11-20'})
        self.ops.batch({'action': 'set_planned', 'document_ids': [b], 'planned_date': '2026-11-10'})
        rendered = self.docs.render_delivery({'document_id': b, 'base_revision': rev_b})
        self.docs.delivery_record({'document_id': b, 'version_id': rendered['version_id'], 'delivery_hash': rendered['delivery_hash'],
                                   'kind': 'copy_html'})
        self.docs.register_publication({'document_id': b, 'version_id': rendered['version_id'], 'published_at': '2026-11-11T09:00:00'})
        month = self.ops.calendar({'month': '2026-11'})
        self.assertEqual([(p['date'], p['title']) for p in month['planned']], [('2026-11-10', '已发稿'), ('2026-11-20', '计划稿')])
        self.assertTrue(month['planned'][0]['published'])
        self.assertEqual(month['published'][0]['date'], '2026-11-11')
        self.assertEqual(self.ops.calendar({'month': '2026-12'})['planned'], [])
        self.assertEqual({r['document_id']: r for r in self.docs.list({})['documents']}[a]['planned_date'], '2026-11-20')
        self.ops.plan({'document_id': a, 'planned_date': None})
        self.assertEqual(len(self.ops.calendar({'month': '2026-11'})['planned']), 1)
        with self.assertRaises(DocumentError):
            self.ops.calendar({'month': '2026/11'})

    def test_suggestions_overview_and_bulk_dismiss(self):
        a, rev = self.make('有建议的稿')
        assist = DocumentAssist(self.service, self.store, self.account,
                                submit=lambda pid, req, cancel: DocumentAssist(self.service, self.store, self.account).run(pid, req, lambda r: Fake()))
        proposal = assist.start({'document_id': a, 'action': 'rewrite', 'block_ids': ['b0000000001'], 'base_revision': rev})
        overview = self.ops.suggestions({})
        self.assertEqual(overview['counts'], {'ready': 1})
        self.assertEqual(overview['items'][0]['title'], '有建议的稿')
        self.assertEqual(overview['items'][0]['ops'], 1)
        self.docs.save_working({'document_id': a, 'base_revision': rev, 'content': doc('用户又改了')})
        self.assertEqual(self.ops.suggestions({})['items'][0]['stale'], 1)
        after = self.ops.dismiss_suggestions({'proposal_ids': [proposal['proposal_id']]})
        self.assertEqual(after['items'], [])
        with self.assertRaises(DocumentError):
            self.ops.dismiss_suggestions({'proposal_ids': ['prop-missing']})

    def test_library_tags(self):
        ids = []
        for index, color in enumerate(((200, 0, 0), (0, 200, 0), (0, 0, 200))):
            buffer = io.BytesIO()
            Image.new('RGB', (30, 20), color).save(buffer, 'PNG')
            ids.append(self.docs.image_import_data({'data_url': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode(),
                                                    'name': f'图{index}'})['resource_id'])
        self.ops.tag({'resource_id': ids[0], 'tags': ['#封面', ' 封面 ', '产品图']})
        self.ops.tag({'resource_ids': ids[1:], 'tags': ['产品图'], 'mode': 'add'})
        library = self.ops.library({})
        self.assertEqual(library['total'], 3)
        self.assertEqual(library['tags'][0], {'tag': '产品图', 'count': 3})
        self.assertEqual(self.ops.library({'tag': '封面'})['items'][0]['resource_id'], ids[0])
        self.assertEqual(self.ops.library({'query': '图2'})['items'][0]['resource_id'], ids[2])
        self.ops.tag({'resource_ids': ids, 'tags': ['产品图'], 'mode': 'remove'})
        self.assertEqual(self.ops.library({'tag': '产品图'})['total'], 0)
        self.assertEqual(self.ops.library({'limit': 2, 'offset': 2})['items'][0]['resource_id'], self.ops.library({})['items'][2]['resource_id'])
        with self.assertRaises(DocumentError):
            self.ops.tag({'resource_id': ids[0], 'tags': ['长' * 21]})
        with self.assertRaises(DocumentError):
            self.ops.tag({'resource_id': ids[0], 'tags': [str(i) for i in range(11)]})


if __name__ == '__main__':
    unittest.main()
