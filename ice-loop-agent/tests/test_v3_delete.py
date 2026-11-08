"""v3.14 文章永久删除：只删回收站里的文章；已登记发布、仍在生成的保留；按公众号隔离；图片资源不删。"""
from __future__ import annotations

import base64
import io
import unittest
from types import SimpleNamespace

from PIL import Image

from ice_agent.application.documents import PUBLIC
from ice_agent.documents.schema import DocumentError
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store
from ice_agent.domain.types import now_iso

from tests import temp_dir


def doc(text):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': [
        {'type': 'paragraph', 'attrs': {'id': 'b0000000001'}, 'content': [{'type': 'text', 'text': text}]}]}, 'style': {}}


TABLES = ('documents', 'document_working', 'document_versions', 'document_import_originals',
          'document_deliveries', 'document_proposals', 'publication_records')


class TestDeleteForever(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-delete-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.service = SimpleNamespace(runtime=self.runtime)
        self.docs = DocumentService(self.service, self.store, {'id': 'acct-a'})
        self.other = DocumentService(self.service, self.store, {'id': 'acct-b'})

    def tearDown(self):
        self.store.close()

    def make(self, service=None, title='稿'):
        service = service or self.docs
        created = service.create({'kind': 'blank', 'title': title})
        saved = service.save_working({'document_id': created['document_id'], 'base_revision': created['revision'], 'content': doc('正文')})
        service.commit_version({'document_id': created['document_id'], 'base_revision': saved['revision'], 'note': '定稿'})
        return created['document_id']

    def rows(self, document_id):
        return {t: self.store.conn.execute(f'SELECT COUNT(*) FROM {t} WHERE document_id=?', (document_id,)).fetchone()[0] for t in TABLES}

    def test_rpc_is_public(self):
        self.assertIn('documents.delete_forever', PUBLIC)

    def test_only_trashed_documents_are_deleted(self):
        document_id = self.make()
        result = self.docs.delete_forever({'document_ids': [document_id]})
        self.assertEqual(result['deleted'], [])
        self.assertIn('回收站', result['kept'][0]['reason'])
        self.docs.trash({'document_id': document_id})
        self.assertGreater(self.rows(document_id)['document_versions'], 0)
        result = self.docs.delete_forever({'document_ids': [document_id]})
        self.assertEqual(result, {'deleted': [document_id], 'kept': []})
        self.assertEqual(set(self.rows(document_id).values()), {0})
        with self.assertRaises(DocumentError):
            self.docs.get({'document_id': document_id})

    def test_import_originals_are_deleted_with_document(self):
        imported = self.docs.import_paste({'html': '<p>导入的正文</p>', 'text': '导入的正文'})
        document_id = imported['document_id']
        self.assertGreater(self.rows(document_id)['document_import_originals'], 0)
        self.docs.trash({'document_id': document_id})
        self.docs.delete_forever({'document_ids': [document_id]})
        self.assertEqual(set(self.rows(document_id).values()), {0})

    def test_other_account_is_rejected_as_a_whole(self):
        mine = self.make()
        theirs = self.make(self.other)
        self.docs.trash({'document_id': mine})
        self.other.trash({'document_id': theirs})
        with self.assertRaises(DocumentError):
            self.docs.delete_forever({'document_ids': [mine, theirs]})
        self.assertEqual(self.rows(mine)['documents'], 1)  # 整批未改
        self.assertEqual(self.rows(theirs)['documents'], 1)

    def test_published_and_generating_are_kept(self):
        published, generating, plain = self.make(title='已发布'), self.make(title='生成中'), self.make(title='普通')
        version = self.docs.versions({'document_id': published})[0]['version_id']
        self.store.conn.execute("INSERT INTO publication_records VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                ('rec1', 'acct-a', published, version, None, '', now_iso(), '', 'user_registered', 'active', now_iso()))
        self.store.conn.execute("INSERT INTO document_proposals(proposal_id,account_id,document_id,base_revision,base_content_hash,action,status,created_at)"
                                " VALUES ('p1','acct-a',?,1,'h','rewrite','generating',?)", (generating, now_iso()))
        self.store.conn.commit()
        for document_id in (published, generating, plain):
            self.docs.trash({'document_id': document_id})
        result = self.docs.delete_forever({'all_trashed': True})
        self.assertEqual(result['deleted'], [plain])
        reasons = {k['document_id']: k['reason'] for k in result['kept']}
        self.assertIn('已登记发布', reasons[published])
        self.assertIn('修改建议', reasons[generating])
        # 撤回登记后可以删除，已撤回的登记随文章删除
        self.docs.withdraw_publication({'record_id': 'rec1'})
        self.assertEqual(self.docs.delete_forever({'document_ids': [published]})['deleted'], [published])
        self.assertEqual(self.rows(published)['publication_records'], 0)

    def test_empty_trash_only_touches_current_account(self):
        mine, theirs = self.make(), self.make(self.other)
        self.docs.trash({'document_id': mine})
        self.other.trash({'document_id': theirs})
        self.assertEqual(self.docs.delete_forever({'all_trashed': True})['deleted'], [mine])
        self.assertEqual(self.rows(theirs)['documents'], 1)
        self.assertEqual(self.docs.delete_forever({'all_trashed': True}), {'deleted': [], 'kept': []})

    def test_bad_params(self):
        for bad in ({}, {'document_ids': []}, {'document_ids': [1]}, {'document_ids': 'x'}, {'all_trashed': 'yes'},
                    {'document_ids': [f'd{i}' for i in range(201)]}):
            with self.assertRaises(DocumentError):
                self.docs.delete_forever(bad)

    def test_image_resources_are_kept(self):
        buffer = io.BytesIO()
        Image.new('RGB', (32, 20), (10, 120, 200)).save(buffer, 'PNG')
        image = self.docs.image_import_data({'data_url': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode(), 'name': '图'})
        created = self.docs.create({'kind': 'blank', 'title': '图文'})
        self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'], 'content': {
            'schema': 1, 'style': {}, 'doc': {'type': 'doc', 'content': [
                {'type': 'articleImage', 'attrs': {'resourceId': image['resource_id'], 'caption': '', 'width': 100}}]}}})
        self.docs.trash({'document_id': created['document_id']})
        self.docs.delete_forever({'document_ids': [created['document_id']]})
        view = self.docs.image_view({'resource_id': image['resource_id']})  # 素材库仍可用
        self.assertTrue(view)

if __name__ == '__main__':
    unittest.main()
