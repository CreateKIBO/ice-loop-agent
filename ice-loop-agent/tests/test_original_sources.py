"""Original metadata remains private, scoped and byte-verified; no image data URI."""
import unittest
from unittest.mock import patch
from pathlib import Path
from PIL import Image
from tests import test_v2_editor as editor_fixture
from tests.test_workflow import demo_spec

class TestOriginalSources(unittest.TestCase):
    setUp=editor_fixture.TestEditorJourney.setUp
    tearDown=editor_fixture.TestEditorJourney.tearDown
    _call=editor_fixture.TestEditorJourney._call
    def candidate(self):
        file=self.root/'original.png';Image.new('RGB',(64,48),'#2448DB').save(file)
        engine,_,store=self.service._job_app(self.job)
        try:return engine.import_asset(self.job,store.article_slots(self.article)[0]['figure_no'],file,accept=True)
        finally:store.close()
    def source(self,**params):
        return self._call('images.original_source',{'account_id':'ice-loop',**params})
    def test_candidate_metadata_has_no_image_body_and_legacy_preview_still_works(self):
        row=self.candidate()
        # Original metadata must not allocate the entire compressed image just to hash it.
        with patch.object(Path,'read_bytes',side_effect=AssertionError('unbounded original read')):
            source=self.source(kind='candidate',candidate_id=row['candidate_id'])
        self.assertEqual(source['sha256'],row['sha256']);self.assertEqual((source['width'],source['height']),(64,48))
        self.assertNotIn('data_url',source);self.assertLess(len(str(source)),2000)
        self.assertTrue(self._call('assets.preview',{'candidate_id':row['candidate_id'],'original':True}).startswith('data:image/png;base64,'))
    def test_resource_source_uses_account_scope_and_never_takes_a_client_path(self):
        file=self.root/'resource.png';Image.new('RGB',(40,30),'#F3F2ED').save(file)
        row=self.service.call('resources.import',{'file_path':str(file)})
        source=self.source(kind='resource',resource_id=row['resource_id'],file_path='C:/secret.txt')
        self.assertEqual(source['sha256'],row['sha256']);self.assertNotEqual(source['file_path'],'C:/secret.txt')
        with self.assertRaises(ValueError):self.source(kind='resource',resource_id=row['resource_id'],account_id='another-account')
    def test_cross_article_and_cross_account_sources_are_rejected(self):
        row=self.candidate()
        with self.assertRaises(ValueError):self.source(kind='candidate',candidate_id=row['candidate_id'],account_id='another-account')
        engine,_,store=self.service._app(demo=True)
        try:other,_=engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop','article_root':str(self.root/'articles')})
        finally:store.close()
        with self.assertRaises(ValueError):self.source(kind='candidate',candidate_id=row['candidate_id'],job_id=other)
        with self.assertRaises(ValueError):self.source(kind='arbitrary-file',file_path=str(self.root/'arbitrary'))
    def test_changed_source_is_rejected_without_touching_body(self):
        row=self.candidate();before=self._call('articles.document',{})['content_hash'];source=self.source(kind='candidate',candidate_id=row['candidate_id'])
        with Path(source['file_path']).open('ab') as stream:stream.write(b'changed')
        with self.assertRaises(ValueError):self.source(kind='candidate',candidate_id=row['candidate_id'])
        self.assertEqual(self._call('articles.document',{})['content_hash'],before)
