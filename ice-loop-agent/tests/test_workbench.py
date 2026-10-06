import json
import hashlib
import unittest
import subprocess
import shutil
from unittest.mock import patch
from datetime import datetime,timedelta,timezone
from pathlib import Path
from PIL import Image,ImageDraw
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.rules.sources import RuleSources
from ice_agent.export.rich_text import rich_text
from tests import REPO,temp_dir

class TestWorkbench(unittest.TestCase):
    def setUp(self):
        self.dir=temp_dir('workbench-');self.s=DesktopService(REPO,self.dir/'runtime',self.dir/'articles')
    def tearDown(self):self.s.close()
    def call(self,method,**params):return self.s.call(method,params)
    def image(self):
        file=self.dir/'cover.png';image=Image.new('RGB',(1000,600),'#F3F2ED');ImageDraw.Draw(image).rectangle((0,0,80,80),fill='#2448DB');image.save(file)
        return self.call('resources.import',file_path=str(file))
    def test_conflict_cas_priority_scope(self):
        for name,value in [('品牌A',30),('品牌B',26)]:self.call('rules.save',name=name,kind='brand',text=name,rules={'title_max_chars':value})
        rules=self.call('rules.list');self.assertEqual(len(rules['conflicts']),1);conflict=rules['conflicts'][0]
        with self.assertRaises(ValueError):self.call('rules.resolve',key=conflict['key'],context_hash='stale',source_id=conflict['candidates'][0]['source_id'])
        resolved=self.call('rules.resolve',key=conflict['key'],context_hash=conflict['context_hash'],source_id=conflict['candidates'][0]['source_id']);self.assertEqual(resolved['effective']['title_max_chars'],30)
        self.call('rules.save',name='当前覆盖',kind='task',text='用户明确覆盖',rules={'title_max_chars':20})
        self.assertEqual(self.call('rules.list')['effective']['title_max_chars'],20)
        _,_,store=self.s._app()
        try:self.assertEqual(RuleSources(store,'different').list()['sources'],[])
        finally:store.close()
    def test_rule_keys_cannot_execute_code(self):
        with self.assertRaises(ValueError):self.call('rules.save',name='恶意',text='os.system',rules={'execute':'something'})
    def test_crop_redaction_preserves_original(self):
        row=self.image();before=Path(row['file_path']).read_bytes()
        result=self.call('resources.transform',resource_id=row['resource_id'],content_hash=row['content_hash'],crop=[0,0,500,300],redactions=[[100,100,200,200]],reason='遮挡私人内容')
        with Image.open(result['file_path']) as image:self.assertEqual(image.size,(500,300));self.assertEqual(image.getpixel((150,150)),(21,25,31))
        self.assertEqual(Path(row['file_path']).read_bytes(),before);self.assertEqual(result['derivation']['parent_sha256'],row['sha256'])
        with self.assertRaises(ValueError):self.call('resources.transform',resource_id=row['resource_id'],content_hash='stale',crop=[0,0,1,1],reason='测试')
    def test_cover_exact_text_preserves_logo_pixels(self):
        row=self.image();result=self.call('resources.cover',resource_id=row['resource_id'],content_hash=row['content_hash'],title='让电脑替你重复干活',period='PY / 111',text_rect=[100,100,950,550])
        with Image.open(row['file_path']) as old,Image.open(result['file_path']) as new:
            self.assertEqual(old.crop((0,0,90,90)).tobytes(),new.crop((0,0,90,90)).tobytes())
            self.assertNotEqual(old.crop((100,100,950,550)).tobytes(),new.crop((100,100,950,550)).tobytes())
        self.assertEqual(result['derivation']['title'],'让电脑替你重复干活');self.assertEqual(result['derivation']['period'],'PY / 111')
    def test_reminders_due_and_dismissed(self):
        now=datetime.now(timezone.utc)-timedelta(minutes=1);rows=self.call('reminders.save',title='发布前核验',due_at=now.isoformat())
        self.assertTrue(rows[0]['due']);self.assertEqual(self.call('reminders.dismiss',reminder_id=rows[0]['reminder_id']),[])
        with self.assertRaises(ValueError):self.call('reminders.save',title='no tz',due_at='2026-10-02T18:00')
    def test_diagnostics_do_not_include_secret_or_body(self):
        result=self.call('tools.diagnostics');text=Path(result['file_path']).read_text(encoding='utf-8')
        self.assertNotIn('api_key_env',text);self.assertNotIn('base_url',text);self.assertNotIn(str(REPO),text);self.assertIn('SQLite',text)
    def test_rich_inline_and_inert_html(self):
        html=rich_text('# 标题\n\n<script>alert(1)</script>\n\n```python\nprint("ok")\n```','标题',{})
        self.assertNotIn('<script>',html);self.assertIn('style="font-size',html);self.assertIn('&lt;script&gt;',html)
    def test_migration_backup_and_future_version(self):
        db=self.dir/'old.db';store=Store(db);store.conn.execute('PRAGMA user_version=0');store.conn.commit();store.close()
        store=Store(db);self.assertTrue(self.dir.joinpath('old-before-v1.0.db').is_file());store.conn.execute('PRAGMA user_version=999');store.conn.commit();store.close()
        with self.assertRaises(ValueError):Store(db)

    @unittest.skipUnless(shutil.which('git'), 'Git is not installed')
    def test_git_preview_stale_guard_and_local_commit(self):
        root=self.dir/'git-archive';root.mkdir()
        def git(*args):
            return subprocess.run([shutil.which('git'),'-C',str(root),*args],check=True,capture_output=True).stdout.decode('utf-8').strip()
        git('init');git('config','user.name','Local acceptance');git('config','user.email','acceptance@example.invalid')
        file=root/'文章 标题.md';file.write_text('原始正文',encoding='utf-8')
        git('add','--',file.name);git('commit','-m','Initial local fixture')
        account={**self.s._account(),'article_root':str(root)}
        with patch.object(self.s,'_account',return_value=account):
            file.write_text('第一次修改',encoding='utf-8')
            pending=root/'另一篇 草稿.md';pending.write_text('新草稿',encoding='utf-8')
            preview=self.call('git.preview')
            self.assertIn('第一次修改',preview['diff']);self.assertIn('新草稿',preview['diff'])
            self.assertEqual({r['path'] for r in preview['files']},{file.name,pending.name})
            file.write_text('预览之后再次修改',encoding='utf-8')
            with self.assertRaises(ValueError):self.call('git.apply',content_hash=preview['content_hash'],action='commit',message='Must reject stale review')
            fresh=self.call('git.preview')
            self.assertTrue(self.call('git.apply',content_hash=fresh['content_hash'],action='commit',message='Reviewed local archive')['ok'])
            self.assertEqual(git('status','--porcelain'),'');self.assertEqual(git('log','-1','--format=%s'),'Reviewed local archive')
