import copy
import hashlib
import json
import unittest
import zipfile
from pathlib import Path

from PIL import Image

from ice_agent.backup import create_backup, inspect_backup, restore_backup, safe_name
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from ice_agent.export.html_preview import PREVIEW_NAME, article_html
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestMaintenance(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('maintenance-')
        self.runtime=self.root/'runtime'
        self.service=DesktopService(REPO,self.runtime,self.root/'articles')
        self.engine,_,self.store=self.service._app(demo=True)
        spec={**demo_spec(),'account_id':'ice-loop','article_root':str(self.root/'articles'),'demo':True}
        self.job,self.article=self.engine.create_job(spec)
        self.body='# 测试标题\n\n第一段。\n\n## 写在最后\n\n保留内容。\n'
        state=self.engine._load_state(self.job)
        state.update(integrated_md=self.body,final_title='测试标题',runs={},series='PY')
        self.engine._save_state(self.job,state)
        self.store.update_job(self.job,state='completed',current_node='export')
        self.store.add_revision({'revision_id':'rev-original','article_id':self.article,'kind':'final',
            'content':self.body,'content_hash':sha256_text(self.body)})

    def tearDown(self):
        self.store.close();self.service.close()

    def save(self,body):
        return self.service.call('articles.save',{'job_id':self.job,'body':body,'content_hash':sha256_text(self.body)})

    def backup(self):
        return self.service.call('backup.create',{'file_path':str(self.root/'workspace.zip')})

    def test_save_diff_restore_preserves_before_body_and_requires_recheck(self):
        changed=self.body.replace('第一段','改过的段落')
        saved=self.save(changed)
        diff=self.service.call('articles.compare',{'job_id':self.job,'revision_id':'rev-original'})
        self.assertIn('-第一段',diff['diff']);self.assertIn('+改过的段落',diff['diff'])
        restored=self.service.call('articles.restore',{'job_id':self.job,'revision_id':'rev-original','content_hash':saved['content_hash']})
        self.assertEqual(restored['content_hash'],sha256_text(self.body))
        self.assertEqual(self.store.get_article(self.article)['readiness'],'review_pending')
        self.assertNotIn('final_check_report',self.store.load_checkpoint(self.job))
        rows=self.store.conn.execute('SELECT content FROM article_revisions WHERE article_id=?',(self.article,)).fetchall()
        self.assertIn(changed,[row[0] for row in rows])
        self.assertEqual(self.service.call('articles.revisions',{'job_id':self.job})['revisions'][0]['kind'],'restore')

    def test_stale_restore_rolls_back_without_losing_current(self):
        changed=self.body+'\n补充内容\n';self.save(changed)
        before=self.store.conn.execute('SELECT COUNT(*) FROM article_revisions').fetchone()[0]
        with self.assertRaisesRegex(ValueError,'正文已变化'):
            self.service.call('articles.restore',{'job_id':self.job,'revision_id':'rev-original','content_hash':sha256_text(self.body)})
        self.assertEqual(self.store.load_checkpoint(self.job)['integrated_md'],changed)
        self.assertEqual(before,self.store.conn.execute('SELECT COUNT(*) FROM article_revisions').fetchone()[0])

    def test_corrupt_revision_and_cross_account_are_rejected(self):
        self.store.conn.execute("UPDATE article_revisions SET content='tampered' WHERE revision_id='rev-original'");self.store.conn.commit()
        with self.assertRaisesRegex(ValueError,'已损坏'):
            self.service.call('articles.restore',{'job_id':self.job,'revision_id':'rev-original','content_hash':sha256_text(self.body)})
        self.service.settings['accounts']['another']={**self.service._account(),'id':'another'}
        self.service.settings['active_account_id']='another'
        with self.assertRaisesRegex(ValueError,'当前公众号'):
            self.service.call('articles.compare',{'job_id':self.job,'revision_id':'rev-original'})
        with self.assertRaisesRegex(ValueError,'当前公众号'):
            self.save(self.body+'more')

    def test_active_lease_blocks_edits_and_backups(self):
        self.store.update_job(self.job,lease='worker')
        with self.assertRaises(ValueError):self.save(self.body+'more')
        with self.assertRaisesRegex(ValueError,'正在运行'):self.backup()

    def test_roundtrip_rebases_resources_and_checkpoints_excludes_credentials(self):
        file=self.root/'input.png';Image.new('RGB',(48,24),'#2448DB').save(file)
        resource=self.service.call('resources.import',{'file_path':str(file)})
        self.service.call('drafts.save',{'title':'我的草稿','body':'保存的正文'})
        (self.runtime/'credentials.json').write_text('FAKE_PRIVATE_KEY',encoding='utf-8')
        (self.runtime/'electron').mkdir();(self.runtime/'electron'/'session.txt').write_text('PRIVATE_SESSION')
        self.service.settings['profiles']['qwen']['api_key']='SHOULD_NOT_EXPORT'
        summary=self.backup();package=Path(summary['file_path'])
        with zipfile.ZipFile(package) as archive:
            self.assertFalse(any('credentials' in name or 'electron' in name for name in archive.namelist()))
            self.assertNotIn('SHOULD_NOT_EXPORT',archive.read('runtime/settings.json').decode())
        restored=restore_backup(package,self.root/'restored',summary['package_hash'])
        service=DesktopService(REPO,Path(restored['runtime_root']))
        try:
            migrated=service.call('resources.list')[0]
            self.assertEqual(migrated['sha256'],resource['sha256'])
            self.assertTrue(Path(migrated['file_path']).is_file())
            self.assertTrue(Path(migrated['file_path']).is_relative_to(self.root/'restored'))
            self.assertEqual(service.call('drafts.list')[0]['title'],'我的草稿')
            self.assertEqual(service.call('jobs.get',{'job_id':self.job})['body'],self.body)
            self.assertEqual(service._account()['library_root'],'')
            self.assertTrue(Path(service._account()['article_root']).is_relative_to(self.root/'restored'))
        finally:service.close()

    def test_restore_detects_changed_package_and_existing_directory(self):
        summary=self.backup();package=Path(summary['file_path'])
        with self.assertRaisesRegex(ValueError,'新目录'):
            restore_backup(package,self.runtime,summary['package_hash'])
        with self.assertRaisesRegex(ValueError,'已变化'):
            restore_backup(package,self.root/'new','wrong-hash')
        self.assertFalse((self.root/'new').exists())

    def test_unlisted_and_traversal_entries_fail_before_extraction(self):
        summary=self.backup();package=Path(summary['file_path'])
        with zipfile.ZipFile(package,'a') as archive:archive.writestr('../escape.txt','bad')
        with self.assertRaises(ValueError):inspect_backup(package)
        self.assertFalse((self.root.parent/'escape.txt').exists())
        for name in ['runtime/../outside','runtime/a:b','/absolute','runtime\\escape','runtime/CON.txt','runtime/a.']:
            with self.assertRaises(ValueError,msg=name):safe_name(name)

    def test_corrupted_file_hash_fails_package_validation(self):
        summary=self.backup();package=Path(summary['file_path']);broken=self.root/'broken.zip'
        with zipfile.ZipFile(package) as source,zipfile.ZipFile(broken,'w') as dest:
            for name in source.namelist():
                dest.writestr(name,b'changed' if name=='runtime/settings.json' else source.read(name))
        with self.assertRaisesRegex(ValueError,'校验失败'):inspect_backup(broken)

    def test_backup_path_inside_data_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'目录之外'):
            self.service.call('backup.create',{'file_path':str(self.runtime/'nested.zip')})

    def test_missing_managed_resource_never_creates_incomplete_backup(self):
        file=self.root/'source.png';Image.new('RGB',(48,24),'blue').save(file)
        resource=self.service.call('resources.import',{'file_path':str(file)})
        Path(resource['file_path']).unlink()
        with self.assertRaisesRegex(ValueError,'备份未保存'):self.backup()
        self.assertFalse((self.root/'workspace.zip').exists())

    def test_html_escapes_code_and_html_and_uses_only_reviewed_images(self):
        md='# 标题\n\n<script>alert(1)</script>\n\n```python\nprint("<x>&")\n```\n\n![图1：真实图片](https://tracker/a.png)\n\n![图2：未导入](待配图：生图)'
        result=article_html(md,'<title>','assets_pending',{1:'images/figure-01.png'})
        self.assertNotIn('<script>',result);self.assertNotIn('https://tracker',result)
        self.assertIn('print(&quot;&lt;x&gt;&amp;&quot;)',result)
        self.assertIn('src="images/figure-01.png"',result);self.assertIn('待配图',result)
        self.assertIn('草稿预览',result);self.assertIn('default-src',result)

    def test_html_theme_uses_frozen_brand_without_rewriting_code(self):
        result=article_html('# 品牌\n\n```python\nprint("#2448DB")\n```','品牌','draft',{},['#227744','#222222','#FFFFEE'])
        self.assertIn('solid #227744',result)
        self.assertIn('print(&quot;#2448DB&quot;)',result)
        self.assertIn('background:#FFFFEE',result)
        malicious=article_html('# 正文','test','draft',{},['red;}</style><script>alert(1)</script>'])
        self.assertNotIn('<script>',malicious)

    def test_export_html_obeys_external_edit_guard(self):
        from ice_agent.workflow.nodes import NodeContext
        state=self.engine._load_state(self.job)
        ctx=self.engine._make_ctx(self.store.get_job(self.job),self.store.get_article(self.article),state)
        result=self.engine.exporter(ctx)
        preview=Path(result['folder'])/PREVIEW_NAME
        self.assertTrue(preview.is_file());self.assertIn(PREVIEW_NAME,result['files'])
        preview.write_text('external edit',encoding='utf-8')
        from ice_agent.export.exporter import ExportConflict
        with self.assertRaises(ExportConflict):self.engine.exporter(ctx)

    def test_title_edit_fails_final_title_check(self):
        changed=self.body.replace('# 测试标题','# 未确认的新标题')
        self.save(changed)
        self.service.call('articles.finalize',{'job_id':self.job})
        report=self.store.load_checkpoint(self.job)['final_check_report']
        self.assertFalse(report['ready'])
        self.assertTrue(any(issue['rule']=='title.approval' for issue in report['rules']['report']['blocking']))


if __name__=='__main__':unittest.main()
