import copy
import hashlib
import json
import unittest
from pathlib import Path

from PIL import Image

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from ice_agent.supplements import parse_source, render_body
from tests import REPO,temp_dir


class TestSupplements(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('supplement-');self.runtime=self.root/'runtime'
        self.service=DesktopService(REPO,self.runtime,self.root/'articles')
        self.original=self.root/'original';self.original.mkdir()
        self.file=self.original/'01-公众号正文.md'
        self.body='# PY / 007 原稿标题\r\n\r\n原来的正文与承诺。\r\n\r\n![图1：封面](images/old.png)\r\n\r\n## 一、真实示例\r\n\r\n```python\r\nprint("补图示例")\r\n```\r\n\r\n![图2：运行截图](待配图：截图｜Agent)\r\n\r\n## 写在最后\r\n\r\n正文保持原样。\r\n'
        self.raw=b'\xef\xbb\xbf'+self.body.encode('utf-8');self.file.write_bytes(self.raw)
        (self.original/'images').mkdir();Image.new('RGB',(240,120),'#2448DB').save(self.original/'images/old.png')
        self.job=self.service.call('supplements.create',{'file_path':str(self.file)})['job_id']

    def tearDown(self):self.service.close()
    def data(self):return self.service.call('jobs.get',{'job_id':self.job})
    def plan(self,slots=None,data=None):
        data=data or self.data()
        return self.service.call('supplements.plan',{'job_id':self.job,'plan_hash':data['supplement']['plan_hash'],'slots':slots or data['slots']})
    def decision(self,decision,note='',data=None):
        data=data or self.data();slot=data['slots'][0];candidate=slot['candidates'][0]
        return self.service.call('assets.review',{'job_id':self.job,'candidate_id':candidate['candidate_id'],
            'slot_hash':slot['content_hash'],'content_hash':candidate['content_hash'],'decision':decision,'note':note})

    def test_snapshot_title_episode_source_and_model_budget(self):
        data=self.data()
        self.assertEqual(data['body'],self.body);self.assertEqual(data['article']['episode'],7)
        self.assertEqual(data['article']['final_title'],'PY / 007 原稿标题')
        self.assertEqual(data['job']['workflow'],'supplement_images_v1')
        self.assertEqual(data['job']['limits']['max_model_calls'],0);self.assertEqual(data['invocations'],[])
        self.assertEqual(data['supplement']['source']['sha256'],hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(self.file.read_bytes(),self.raw)
        self.assertEqual(data['slots'][0]['candidates'][0]['review_status'],'pending')
        self.assertFalse(data['slots'][0]['valid'])

    def test_raw_body_cannot_save_restore_or_enter_writer(self):
        for method,params in [('articles.save',{'body':'changed','content_hash':sha256_text(self.body)}),
                              ('articles.restore',{'revision_id':'anything','content_hash':sha256_text(self.body)}),
                              ('jobs.resume',{}),('execution.approve',{})]:
            with self.assertRaises(ValueError,msg=method):self.service.call(method,{'job_id':self.job,**params})
        engine,_,store=self.service._job_app(self.job)
        try:
            with self.assertRaises(ValueError):engine.run(self.job)
        finally:store.close()
        self.assertEqual(self.data()['body'],self.body)

    def test_fenced_images_and_headings_are_not_slots_or_anchors(self):
        parsed=parse_source('# 标题\n\n~~~python\nprint("x")\n# 假标题\n![图3：假图片](x.png)\n~~~\n\n![普通图片](real.png)\n')
        self.assertEqual(len(parsed['images']),1);self.assertEqual(parsed['images'][0]['figure_no'],1)
        self.assertEqual(len(parsed['codes']),1);self.assertEqual(len(parsed['anchors']),2)

    def test_duplicate_image_numbers_and_unclosed_code_are_rejected(self):
        for body in ['# T\n![图1：A](a)\n![图1：B](b)\n','# T\n```python\nprint(1)']:
            with self.assertRaises(ValueError):parse_source(body)

    def test_plan_addition_keeps_original_offsets_ignores_client_source_ranges(self):
        data=self.data();slots=copy.deepcopy(data['slots'])
        slots[0]['source_image']['url_start']=0
        slots.append({'figure_no':3,'kind':'body_ai','caption':'新增插图','prompt':'Use case: conceptual illustration.','anchor_id':'intro'})
        self.plan(slots,data);updated=self.data()
        self.assertEqual(updated['body'],self.body);self.assertEqual(len(updated['slots']),3)
        self.assertNotEqual(updated['slots'][0]['source_image']['url_start'],0)
        rendered=render_body(self.body,updated['slots'],{1:'images/figure-01.png',3:'images/figure-03.png'})
        self.assertIn('![图1：封面](images/figure-01.png)\r\n',rendered)
        self.assertIn('![图3：新增插图](images/figure-03.png)',rendered)
        self.assertIn('print("补图示例")',rendered)
        self.assertEqual(self.file.read_bytes(),self.raw)

    def test_stale_plan_duplicate_figures_and_dropping_source_slots_fail(self):
        data=self.data();self.decision('accepted')
        with self.assertRaisesRegex(ValueError,'变化'):self.plan(data=data)
        current=self.data();slots=copy.deepcopy(current['slots']);slots[1]['figure_no']=1
        with self.assertRaises(ValueError):self.plan(slots,current)
        with self.assertRaises(ValueError):self.plan(current['slots'][:1],current)

    def test_candidate_accept_reject_reaccept_preserves_reason_and_old_image(self):
        self.decision('accepted');data=self.data();self.assertTrue(data['slots'][0]['valid'])
        self.decision('rejected','颜色不适合本文');data=self.data()
        self.assertFalse(data['slots'][0]['valid']);self.assertIsNone(data['slots'][0]['selected_candidate'])
        candidate=data['slots'][0]['candidates'][0]
        self.assertEqual(candidate['review_note'],'颜色不适合本文');self.assertTrue(Path(candidate['file_path']).exists())
        with self.assertRaises(ValueError):self.service.call('assets.select',{'job_id':self.job,'candidate_id':candidate['candidate_id']})
        self.decision('accepted','重新核对后可用');self.assertTrue(self.data()['slots'][0]['valid'])

    def test_stale_review_corrupt_image_and_empty_rejection_reason_fail(self):
        data=self.data()
        with self.assertRaisesRegex(ValueError,'原因'):self.decision('rejected')
        self.decision('accepted')
        with self.assertRaises(ValueError):self.decision('rejected','旧决定',data=data)
        candidate=self.data()['slots'][0]['candidates'][0];Path(candidate['file_path']).write_bytes(b'bad')
        with self.assertRaises(ValueError):self.decision('accepted')

    def test_cross_account_plan_review_execution_and_export_rejected(self):
        self.service.settings['accounts']['other']={**self.service._account(),'id':'other'}
        self.service.settings['active_account_id']='other'
        for method,params in [('supplements.prepare',{'code_index':0}),('supplements.plan',{'slots':[]}),('articles.finalize',{}),('jobs.get',{})]:
            with self.assertRaises(ValueError,msg=method):self.service.call(method,{'job_id':self.job,**params})
        with self.assertRaises(ValueError):self.service.call('assets.review',{'job_id':self.job,'decision':'accepted'})

    def test_changed_source_uses_verified_snapshot_and_never_overwrites(self):
        self.file.write_text('# 外部新正文',encoding='utf-8')
        data=self.data();self.assertEqual(data['body'],self.body)
        self.assertEqual(data['supplement']['source_status'],'changed_or_missing')
        result=self.service.call('articles.finalize',{'job_id':self.job})
        self.assertEqual(self.file.read_text(encoding='utf-8'),'# 外部新正文')
        self.assertTrue(Path(result['export']['folder']).is_relative_to(self.root/'articles'/'补图候选'))

    def test_corrupt_source_snapshot_blocks_export(self):
        snapshot=Path(self.data()['supplement']['source']['file_path']);snapshot.write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError,'快照校验'):self.service.call('articles.finalize',{'job_id':self.job})

    def test_explicit_single_snippet_execution_actual_stdout_and_idempotent_reuse(self):
        prepared=self.service.call('supplements.prepare',{'job_id':self.job,'code_index':0,'stdin':''})
        with self.assertRaises(ValueError):self.service.call('supplements.execute',{'job_id':self.job,'code_index':0,'content_hash':prepared['content_hash']})
        result=self.service.call('supplements.execute',{'job_id':self.job,'code_index':0,'content_hash':prepared['content_hash'],'reviewed':True})
        self.assertEqual(result['run']['stdout'].replace('\r\n','\n'),'补图示例\n');self.assertEqual(result['run']['exit_code'],0)
        self.assertEqual(self.data()['body'],self.body)
        repeated=self.service.call('supplements.execute',{'job_id':self.job,'code_index':0,'content_hash':prepared['content_hash'],'reviewed':True})
        self.assertTrue(repeated['reused']);self.assertEqual(repeated['run']['run_id'],result['run']['run_id'])
        capture=self.service.call('assets.capture_context',{'job_id':self.job,'figure_no':2,'run_keys':[result['run_key']]})
        self.assertEqual(capture['runs'][0]['source'],'print("补图示例")\n')

    def test_changed_input_invalidates_earlier_execution_request(self):
        first=self.service.call('supplements.prepare',{'job_id':self.job,'code_index':0,'stdin':''})
        self.service.call('supplements.prepare',{'job_id':self.job,'code_index':0,'stdin':'new'})
        with self.assertRaises(ValueError):self.service.call('supplements.execute',{'job_id':self.job,'code_index':0,'content_hash':first['content_hash'],'reviewed':True})

    def test_export_all_images_still_needs_text_review_and_preserves_text(self):
        self.decision('accepted')
        self.service.call('assets.import',{'job_id':self.job,'figure_no':2,'file_path':str(self.original/'images/old.png')})
        result=self.service.call('articles.finalize',{'job_id':self.job})
        self.assertEqual(result['readiness'],'images_ready');self.assertTrue(result['assets_ready'])
        folder=Path(result['export']['folder']);body=(folder/'01-公众号正文.md').read_bytes().decode('utf-8')
        expected=self.body.replace('images/old.png','images/figure-01.png').replace('待配图：截图｜Agent','images/figure-02.png')
        self.assertEqual(body,expected);self.assertEqual(self.file.read_bytes(),self.raw)
        changes=json.loads((folder/'05-补图变更记录.json').read_text(encoding='utf-8'))
        self.assertFalse(changes['text_rewritten']);self.assertFalse(changes['publication_review_passed'])
        self.assertIn('草稿预览',(folder/'04-阅读与排版预览.html').read_text(encoding='utf-8'))

    def test_backup_restore_image_job_rebases_snapshot_and_keeps_review_notes(self):
        self.decision('rejected','保留审核说明')
        package=self.service.call('backup.create',{'file_path':str(self.root/'backup.zip')})
        restored=self.service.call('backup.restore',{'file_path':package['file_path'],'destination':str(self.root/'restored'),'package_hash':package['package_hash']})
        service=DesktopService(REPO,Path(restored['runtime_root']))
        try:
            data=service.call('jobs.get',{'job_id':self.job})
            self.assertEqual(data['body'],self.body)
            self.assertTrue(Path(data['supplement']['source']['file_path']).is_relative_to(self.root/'restored'))
            self.assertEqual(data['slots'][0]['candidates'][0]['review_note'],'保留审核说明')
        finally:service.close()

    def test_external_local_image_path_is_not_imported(self):
        file=self.original/'escaping.md';file.write_text('# T\n\n![图1：外部图片](../outside.png)',encoding='utf-8')
        Image.new('RGB',(40,20),'blue').save(self.root/'outside.png')
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id']
        self.assertEqual(self.service.call('jobs.get',{'job_id':job})['slots'][0]['candidates'],[])

    def test_episode_metadata_does_not_use_previous_article_or_fenced_text(self):
        file=self.original/'no-period.md'
        file.write_text('# 本篇标题\n\n上篇 PY / 004 的参考答案。\n\n```python\n# 栏目：PY / 999\nprint(1)\n```\n',encoding='utf-8')
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id']
        article=self.service.call('jobs.get',{'job_id':job})['article']
        self.assertEqual(article['episode'],0);self.assertEqual(article['series'],'UNSPECIFIED')
        self.assertEqual(parse_source('# 标题\n\n栏目：LIFE / 012\n')['publication'],{'series':'LIFE','episode':12})

    def test_source_hash_mismatch_does_not_create_a_job(self):
        count=len(self.service.call('jobs.list'))
        with self.assertRaisesRegex(ValueError,'已变化'):
            self.service.call('supplements.create',{'file_path':str(self.file),'source_hash':'0'*64})
        self.assertEqual(len(self.service.call('jobs.list')),count)

    def test_modified_plan_deselects_old_image_and_exports_edited_cover_prompt(self):
        self.decision('accepted');data=self.data();slots=copy.deepcopy(data['slots'])
        slots[0]['prompt']='Use case: edited cover. No lettering.'
        self.plan(slots,data);current=self.data()
        self.assertIsNone(current['slots'][0]['selected_candidate'])
        self.assertEqual(current['slots'][0]['candidates'][0]['review_status'],'accepted')
        result=self.service.call('articles.finalize',{'job_id':self.job})
        prompt=(Path(result['export']['folder'])/'03-配图提示词.md').read_text(encoding='utf-8')
        self.assertIn(slots[0]['prompt'],prompt)

    def test_paused_image_job_resumes_without_starting_writer(self):
        _,_,store=self.service._job_app(self.job)
        try:store.update_job(self.job,state='paused',pause_reason='恢复后的补图任务')
        finally:store.close()
        result=self.service.call('jobs.resume',{'job_id':self.job})
        self.assertFalse(result['started']);self.assertEqual(self.data()['job']['state'],'completed')
        self.assertEqual(self.data()['invocations'],[]);self.assertEqual(self.data()['body'],self.body)

    def test_no_original_images_can_add_new_slot_and_keep_source(self):
        file=self.original/'plain.md';body='# 没有图片\n\n原段落。\n';file.write_text(body,encoding='utf-8')
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id'];data=self.service.call('jobs.get',{'job_id':job})
        self.assertEqual(data['slots'],[])
        self.service.call('supplements.plan',{'job_id':job,'plan_hash':data['supplement']['plan_hash'],
            'slots':[{'figure_no':1,'kind':'body_ai','caption':'新增图','prompt':'editable','anchor_id':'end'}]})
        result=self.service.call('articles.finalize',{'job_id':job})
        output=(Path(result['export']['folder'])/'01-公众号正文.md').read_text(encoding='utf-8')
        self.assertTrue(output.startswith(body));self.assertIn('![图1：新增图]',output)
        self.assertEqual(file.read_text(encoding='utf-8'),body)

    def test_runtime_error_is_recorded_with_real_stderr_without_rewriting(self):
        file=self.original/'error.md';body='# 报错示例\n\n```python\nprint(1 / 0)\n```\n';file.write_text(body,encoding='utf-8')
        body=file.read_bytes().decode('utf-8')
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id']
        request=self.service.call('supplements.prepare',{'job_id':job,'code_index':0})
        result=self.service.call('supplements.execute',{'job_id':job,'code_index':0,'content_hash':request['content_hash'],'reviewed':True})
        self.assertEqual(result['run']['verdict'],'runtime_error');self.assertNotEqual(result['run']['exit_code'],0)
        self.assertIn('ZeroDivisionError',result['run']['stderr']);self.assertEqual(result['run']['stdout'],'')
        self.assertEqual(self.service.call('jobs.get',{'job_id':job})['body'],body)
        repeated=self.service.call('supplements.execute',{'job_id':job,'code_index':0,'content_hash':request['content_hash'],'reviewed':True})
        self.assertFalse(repeated['reused'])
        self.assertNotEqual(repeated['run']['run_id'],result['run']['run_id'])

    def test_input_required_and_owned_files_cleaned_after_real_age_example(self):
        file=self.original/'age.md';body='# 输入年龄\n\n```python\nage=int(input("请输入年龄："))\nprint(age+1)\n```\n'
        file.write_text(body,encoding='utf-8')
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id']
        with self.assertRaisesRegex(ValueError,'需要示例输入'):
            self.service.call('supplements.prepare',{'job_id':job,'code_index':0,'stdin':''})
        request=self.service.call('supplements.prepare',{'job_id':job,'code_index':0,'stdin':'18'})
        result=self.service.call('supplements.execute',{'job_id':job,'code_index':0,'content_hash':request['content_hash'],'reviewed':True})
        self.assertEqual(result['run']['exit_code'],0,result['run']['stderr'])
        self.assertIn('19',result['run']['stdout'])
        self.assertEqual(result['run']['stdin_events'],['18\n'])
        self.assertFalse(Path(result['run']['runtime']['cwd']).exists())
        self.assertEqual(file.read_text(encoding='utf-8'),body)

    def test_expected_error_requires_bound_review_and_can_be_captured(self):
        file=self.original/'teaching-error.md';file.write_text('# 教学报错\n\n```python\n1/0\n```\n\n![图1：真实错误](待配图：截图｜Agent)\n',encoding='utf-8')
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id']
        first=self.service.call('supplements.prepare',{'job_id':job,'code_index':0})
        expected=self.service.call('supplements.prepare',{'job_id':job,'code_index':0,'expect_failure':True})
        with self.assertRaises(ValueError):
            self.service.call('supplements.execute',{'job_id':job,'code_index':0,'content_hash':first['content_hash'],'reviewed':True})
        result=self.service.call('supplements.execute',{'job_id':job,'code_index':0,'content_hash':expected['content_hash'],'reviewed':True})
        self.assertEqual(result['run']['verdict'],'expected_failure_ok')
        self.assertTrue(result['run']['expected_failure'])
        context=self.service.call('assets.capture_context',{'job_id':job,'figure_no':1,'run_keys':[result['run_key']]})
        self.assertIn('ZeroDivisionError',context['runs'][0]['stderr'])

    def test_java_snippets_with_same_class_name_export_independently(self):
        source1='public class Main { public static void main(String[] args) { System.out.println("first"); } }\n'
        source2=source1.replace('first','second')
        body=f'# Java 原稿\n\n```java\n{source1}```\n\n```java\n{source2}```\n'
        file=self.original/'java.md';file.write_bytes(body.encode('utf-8'))
        job=self.service.call('supplements.create',{'file_path':str(file)})['job_id']
        for index,output in enumerate(('first','second')):
            request=self.service.call('supplements.prepare',{'job_id':job,'code_index':index})
            result=self.service.call('supplements.execute',{'job_id':job,'code_index':index,'content_hash':request['content_hash'],'reviewed':True})
            self.assertEqual(result['run']['exit_code'],0);self.assertEqual(result['run']['stdout'].strip(),output)
        result=self.service.call('articles.finalize',{'job_id':job});folder=Path(result['export']['folder'])
        self.assertEqual((folder/'code/supplement-1/Main.java').read_text(encoding='utf-8'),source1)
        self.assertEqual((folder/'code/supplement-2/Main.java').read_text(encoding='utf-8'),source2)
        self.assertEqual((folder/'01-公众号正文.md').read_bytes().decode('utf-8'),body)


if __name__=='__main__':unittest.main()
