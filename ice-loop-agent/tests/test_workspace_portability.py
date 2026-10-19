"""Moved profiles and real backup/restore must not depend on the old directory."""
import base64
import copy
import gc
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from ice_agent.application.job_context import EVENT, RELOCATION_EVENT
from ice_agent.backup import create_backup, restore_backup
from ice_agent.config import make_runtime_config
from ice_agent.desktop_service import DesktopService
from ice_agent.export.bundle import MD_NAME, TXT_NAME
from ice_agent.paths import assert_within, atomic_write_text
from tests import REPO, load_profile, temp_dir


class TestPortableProfile(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('portable-profile-')

    def profile(self, storage):
        profile = load_profile();profile['storage'] = storage
        file = self.root/'moved-project'/'profiles'/'brand.json'
        atomic_write_text(file,json.dumps(profile,ensure_ascii=False))
        return file

    def test_relative_storage_belongs_to_profile_even_from_a_different_working_directory(self):
        file = self.profile({'article_root_win':'../articles','runtime_root_win':'../runtime'})
        cwd = self.root/'unrelated-cwd';cwd.mkdir()
        script = ('import json,sys;from ice_agent.config import make_runtime_config;'
            'c=make_runtime_config(profile_path=sys.argv[1]);'
            'print(json.dumps([str(c.article_root),str(c.runtime_root)]))')
        # Explicit module search path permits a genuinely different cwd without
        # changing the test runner's process-wide working directory.
        import os
        env = {**os.environ,'PYTHONPATH':str(REPO),'PYTHONDONTWRITEBYTECODE':'1',
               'TEMP':str(self.root),'TMP':str(self.root)}
        result = subprocess.run([sys.executable,'-X','utf8','-B','-c',script,str(file)],
            cwd=cwd,env=env,check=True,capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(json.loads(result.stdout),[str(file.parent.parent/'articles'),str(file.parent.parent/'runtime')])
        self.assertFalse((cwd/'runtime').exists())

    def test_explicit_paths_override_profile_and_legacy_absolute_profile_paths_are_preserved(self):
        old_articles = self.root/'chosen-articles';old_runtime = self.root/'chosen-runtime'
        file = self.profile({'article_root_win':str(old_articles),'runtime_root_win':str(old_runtime)})
        cfg = make_runtime_config(profile_path=file)
        self.assertEqual(cfg.article_root,old_articles);self.assertEqual(cfg.runtime_root,old_runtime)
        cfg = make_runtime_config(self.root/'explicit-articles',self.root/'explicit-runtime',file)
        self.assertEqual(cfg.article_root,self.root/'explicit-articles')
        self.assertEqual(cfg.runtime_root,self.root/'explicit-runtime')

    def test_source_and_frozen_profile_defaults_are_identical_and_portable(self):
        source = json.loads((REPO/'profiles/ice-loop.json').read_text(encoding='utf-8'))
        frozen = json.loads((REPO/'ice_agent/resources/ice-loop.json').read_text(encoding='utf-8'))
        self.assertEqual(source,frozen)
        for key in ('article_root_win','runtime_root_win'):
            self.assertFalse(Path(source['storage'][key]).is_absolute())
            self.assertNotIn('G:',source['storage'][key])


class TestRestoredJobContext(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('restored-context-')
        self.original = self.root/'original'
        self.runtime = self.original/'runtime'
        self.service = DesktopService(REPO,self.runtime,self.original/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        with patch.object(self.service,'_start',return_value={'started':False}):
            created = self.service.call('jobs.create',{'demo':True})
        self.job,self.article = created['job_id'],created['article_id']
        engine,_,store = self.service._job_app(self.job)
        self.body = '# 恢复后的文章\n\n保留正文中的原始路径文字 G:/example，不当作文件引用替换。\n\n![图1：封面](待配图：封面｜手动导入)\n'
        try:
            state = engine._load_state(self.job)
            state.update(integrated_md=self.body,draft_md=self.body,final_title='恢复后的文章',runs={})
            engine._save_state(self.job,state)
            store.upsert_slot({'slot_id':'restored-slot','article_id':self.article,'figure_no':1,
                'kind':'cover','caption':'封面','required':True,'selected_candidate':None})
            image = self.original/'input.png';Image.new('RGB',(64,32),'#2448DB').save(image)
            self.image_bytes = image.read_bytes()
            self.candidate = engine.import_asset(self.job,1,image,accept=True)
        finally:
            store.close()
        self.package = self.root/'first.zip'

    def backup(self):
        return create_backup(self.runtime,self.service.settings,self.package)

    def test_restore_with_original_offline_reads_images_resumes_same_job_and_exports_relative_files(self):
        summary = self.backup()
        restored = restore_backup(self.package,self.root/'restored',summary['package_hash'])
        self.service.close()
        # The source app and restore run in one test process. Release cyclic
        # test/mocking objects before the Windows directory rename; a real
        # source application exit would release those handles with its process.
        gc.collect()
        offline = self.root/'original-offline'
        # Move only this test-owned fixture, with both absolute targets checked.
        assert_within(self.original,self.root);assert_within(offline,self.root)
        self.original.rename(offline)
        self.assertFalse(self.original.exists())
        service = DesktopService(REPO,Path(restored['runtime_root']),auto_consumer=False)
        try:
            data = service.call('jobs.get',{'job_id':self.job})
            self.assertEqual(data['body'],self.body)
            engine,cfg,store = service._job_app(self.job)
            try:
                self.assertTrue(cfg.article_root.is_relative_to(self.root/'restored'))
                original = next(json.loads(e['payload']) for e in store.job_events(self.job) if e['event_type']==EVENT)
                self.assertEqual(original['article_root'],str(self.original/'articles'))
                changes = [json.loads(e['payload']) for e in store.job_events(self.job) if e['event_type']==RELOCATION_EVENT]
                self.assertEqual(len(changes),1)
                self.assertEqual(changes[0]['article_root'],str(cfg.article_root))
                result = engine.run(self.job)
                self.assertEqual(result['state'],'awaiting_approval')
                self.assertEqual(store.pending_approval(self.job)['scope'],'topic')
            finally:
                store.close()
            preview = service.call('assets.preview',{'job_id':self.job,'candidate_id':self.candidate['candidate_id'],'original':True})
            self.assertEqual(base64.b64decode(preview.split(',',1)[1]),self.image_bytes)
            destination = self.root/'publish-bundle'
            result = service.call('articles.export_bundle',{'job_id':self.job,'destination':str(destination),'mode':'draft'})
            self.assertEqual(result['images'],1)
            markdown = (destination/'文本'/MD_NAME).read_text(encoding='utf-8')
            plain = (destination/'文本'/TXT_NAME).read_text(encoding='utf-8')
            self.assertIn('../图片/01-01.png',markdown)
            self.assertIn('图片/01-01.png',plain)
            self.assertIn('G:/example',markdown)
            self.assertEqual((destination/'图片'/'01-01.png').read_bytes(),self.image_bytes)
            # A second restore must use the latest context, not the first old
            # event, and must preserve both historical records.
            second_package = self.root/'second.zip'
            second = create_backup(service.runtime,service.settings,second_package)
        finally:
            service.close()
        second_root = self.root/'second-restore'
        again = restore_backup(second_package,second_root,second['package_hash'])
        service = DesktopService(REPO,Path(again['runtime_root']),auto_consumer=False)
        try:
            _,cfg,store = service._job_app(self.job)
            try:
                self.assertTrue(cfg.article_root.is_relative_to(second_root))
                self.assertEqual(len([e for e in store.job_events(self.job) if e['event_type']==RELOCATION_EVENT]),2)
            finally:
                store.close()
        finally:
            service.close()

    def test_invalid_context_root_or_owner_never_publishes_a_restore(self):
        engine,_,store = self.service._job_app(self.job)
        try:
            event = next(e for e in store.job_events(self.job) if e['event_type']==EVENT)
            original = json.loads(event['payload'])
            for index,change in enumerate(({'article_root':str(self.root/'unadmitted-output')},{'account_id':'other-account'})):
                corrupted = {**copy.deepcopy(original),**change}
                store.conn.execute('UPDATE events SET payload=? WHERE job_id=? AND sequence=?',
                    (json.dumps(corrupted),self.job,event['sequence']));store.conn.commit()
                package = self.root/f'invalid-{index}.zip'
                summary = create_backup(self.runtime,self.service.settings,package)
                target = self.root/f'invalid-restore-{index}'
                with self.assertRaisesRegex(ValueError,'输出目录无法迁移|公众号归属不一致'):
                    restore_backup(package,target,summary['package_hash'])
                self.assertFalse(target.exists())
                self.assertFalse(list(self.root.glob('ice-restore-*')))
        finally:
            store.close()
