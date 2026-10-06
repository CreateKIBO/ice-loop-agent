import base64
import copy
import io
import json
import unittest
from dataclasses import asdict
from unittest.mock import patch

from PIL import Image

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from ice_agent.llm.errors import CapabilityMismatch
from ice_agent.llm.router import LLMRequest, RoleRouter, RouteConfig, image_message
from ice_agent.visual_assets import analyze_resource, image_data, rank_resources, probe_vision
from ice_agent.workspace_assets import WorkspaceAssets
from tests import REPO, temp_dir
from tests.test_router import FakeTransport, make_profile


class TestVisualAssets(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('visual-')
        self.service=DesktopService(REPO,self.root,self.root/'articles')
        self.file=self.root/'blue.png'
        Image.new('RGB',(1800,900),'#2448DB').save(self.file)
        self.resource=self.service.call('resources.import',{'file_path':str(self.file)})

    def tearDown(self):self.service.close()

    def report(self,**changes):
        return dict(summary='蓝色背景的封面样例',tags=['蓝色','封面'],style='平面编辑风格',composition='横向画面',
            visible_text='',suggested_uses=['cover'],limitations='文字需人工核对',theme_colors=[self.resource['palette'][0]['hex']],
            color_explanation='用于公众号强调色',**changes)

    def router(self,transport):
        profile=make_profile('qwen');profile.capabilities['vision']='verified'
        return RoleRouter({profile.profile_id:profile},{'visual_reviewer':RouteConfig(profile.profile_id)},transport=transport)

    def test_compressed_preview_is_bounded_jpeg_without_metadata(self):
        with Image.open(self.file) as source:data=image_data(source)
        with Image.open(io.BytesIO(base64.b64decode(data.split(',')[1]))) as image:
            self.assertEqual(image.format,'JPEG');self.assertEqual(image.size,(1280,640));self.assertFalse(image.getexif())
        self.assertLess(len(data),3_000_000)

    def test_vision_receives_actual_image_and_repair_keeps_it(self):
        transport=FakeTransport([{'ok':'not-json'},{'ok':json.dumps(self.report(),ensure_ascii=False)}])
        _,_,store=self.service._app()
        try:result=analyze_resource(self.router(transport),WorkspaceAssets(store,self.root,'ice-loop'),self.resource,self.service._account())
        finally:store.close()
        self.assertEqual(result['source_sha256'],self.resource['sha256']);self.assertEqual(len(transport.calls),2)
        images=[call['messages'][-1]['content'][-1] for call in transport.calls]
        self.assertEqual(images[0],images[1]);self.assertEqual(images[0]['type'],'image_url')
        self.assertTrue(images[0]['image_url']['url'].startswith('data:image/jpeg;base64,'))

    def test_unsupported_vision_never_calls_text_only_model(self):
        profile=make_profile('qwen');profile.capabilities['vision']='unsupported'
        transport=FakeTransport();router=RoleRouter({profile.profile_id:profile},{'visual_reviewer':RouteConfig(profile.profile_id)},transport=transport)
        with self.assertRaises(CapabilityMismatch):router.generate(LLMRequest('visual_reviewer','visual','inspect',images=['data:image/png;base64,YQ==']))
        self.assertEqual(transport.calls,[])

    def test_invalid_image_message_is_rejected(self):
        for value in ['https://example.com/image.png','data:image/svg+xml;base64,YQ==','data:image/png;base64,!?']:
            with self.assertRaises(ValueError):image_message('test',[value])

    def test_vision_config_preserves_writer_and_requires_probe(self):
        before=copy.deepcopy(self.service.settings['profiles'])
        self.service.call('vision.save',{'provider':'qwen','model_id':'fixture-vision'})
        self.assertEqual(self.service.settings['profiles'],before)
        with self.assertRaisesRegex(ValueError,'识图测试'):self.service._vision_profile()
        with patch('ice_agent.visual_assets.probe_vision',return_value={'model':'fixture-vision'}):
            self.service.call('vision.probe')
        self.assertEqual(self.service._vision_profile().capabilities['vision'],'verified')
        self.service.call('vision.save',{'provider':'qwen','model_id':'another-vision'})
        self.assertEqual(self.service.settings['vision']['status'],'requires_probe')

    def test_probe_rejects_incorrect_visual_response(self):
        transport=FakeTransport([{'ok':'{"color":"blue","shape":"square"}'}])
        from ice_agent.llm.adapters import make_adapter
        with patch('ice_agent.visual_assets.make_adapter',return_value=make_adapter(make_profile('qwen'),transport)):
            with self.assertRaisesRegex(ValueError,'未通过'):probe_vision(make_profile('qwen'))
        self.assertIsInstance(transport.calls[0]['messages'][0]['content'],list)

    def test_metadata_hash_blocks_stale_edit_and_scopes_account(self):
        params={'resource_id':self.resource['resource_id'],'content_hash':self.resource['content_hash'],
            'title':'Python 循环封面','description':'可复用的系列封面','tags':['循环','Python','循环'],'usage':'cover'}
        result=self.service.call('resources.update',params)
        self.assertEqual(result['tags'],['循环','Python']);self.assertNotEqual(result['content_hash'],params['content_hash'])
        with self.assertRaisesRegex(ValueError,'已更新'):self.service.call('resources.update',params)
        with self.assertRaisesRegex(ValueError,'已切换'):self.service.call('resources.update',{**params,'account_id':'other-account'})

    def test_analysis_preserves_manual_metadata(self):
        resource=self.service.call('resources.update',{'resource_id':self.resource['resource_id'],'content_hash':self.resource['content_hash'],
            'title':'我的封面','description':'我的说明','tags':['人工标签'],'usage':'cover'})
        profile=make_profile('qwen');self.service.settings['profiles']['qwen']=asdict(profile)
        self.service.settings['vision']={'provider':'qwen','model_id':'fixture-vision','status':'verified'}
        def fake_analyze(router,box,res,account):
            self.assertEqual(box.checked_path(res).read_bytes(),self.file.read_bytes());return {**self.report(),'model':'fixture-vision'}
        with patch('ice_agent.visual_assets.analyze_resource',side_effect=fake_analyze):
            result=self.service.call('resources.vision',{'resource_id':resource['resource_id'],'content_hash':resource['content_hash']})
        self.assertEqual(result['description'],'我的说明');self.assertEqual(result['tags'],['人工标签'])
        self.assertEqual(result['visual_analysis']['summary'],'蓝色背景的封面样例')

    def test_tampered_resource_never_goes_to_vision(self):
        self.service.settings['profiles']['qwen']=asdict(make_profile('qwen'))
        self.service.settings['vision']={'provider':'qwen','model_id':'fixture-vision','status':'verified'}
        from pathlib import Path
        Path(self.resource['file_path']).write_bytes(b'changed')
        with patch.object(RoleRouter,'generate') as generate:
            with self.assertRaises(ValueError):self.service.call('resources.vision',{'resource_id':self.resource['resource_id'],'content_hash':self.resource['content_hash']})
            generate.assert_not_called()

    def test_ai_palette_cannot_invent_unmeasured_colors(self):
        report=self.report();report['theme_colors']=['#FF0000'];transport=FakeTransport([{'ok':json.dumps(report)}])
        _,_,store=self.service._app()
        try:
            with self.assertRaisesRegex(ValueError,'实际像素'):analyze_resource(self.router(transport),WorkspaceAssets(store,self.root,'ice-loop'),self.resource,self.service._account())
        finally:store.close()

    def test_rank_prefers_content_and_never_uses_cover_as_real_screenshot(self):
        matching={**self.resource,'resource_id':'matching','title':'Python 循环封面','usage':'cover','tags':['Python','循环']}
        other={**self.resource,'resource_id':'other','title':'阳台阅读','usage':'cover','tags':['阅读']}
        article={'spec':{},'topic':'Python 循环'}
        ranked=rank_resources([other,matching],article,{'kind':'cover','caption':'循环'},'#2448DB')
        self.assertEqual(ranked[0]['resource_id'],'matching')
        self.assertEqual(rank_resources([matching],article,{'kind':'body_real'},'#2448DB'),[])

    def capture_data(self):
        source='print(1)\n';run={'run_id':'run-fixture','filename':'hello.py','source':source,'stdout':'1\n','stderr':'',
            'code_sha256':sha256_text(source),'output_sha256':sha256_text('1\n\x00'),'exit_code':0}
        body='# 示例\n\n```python\nprint(1)\n```\n\n```text\n1\n```\n<!--RUN_REF:run-fixture|'+run['output_sha256'][:12]+'-->\n'
        return {'article':{'spec':{'account_id':'ice-loop'},'topic':'示例','working_title':'示例'},'job':{'lease':None},
            'slots':[{'figure_no':2,'kind':'body_real','caption':'运行输出'}],'runs':{'run-1':run},'body':body}

    def test_capture_checks_real_code_and_output_hashes(self):
        data=self.capture_data()
        with patch.object(self.service,'jobs_get',return_value=data):
            context=self.service.assets_capture_context({'job_id':'fixture','figure_no':2})
            self.assertEqual(context['runs'][0]['stdout'],'1\n')
            data['runs']['run-1']['stdout']='fabricated\n'
            with self.assertRaisesRegex(ValueError,'校验失败'):self.service.assets_capture_context({'job_id':'fixture','figure_no':2})

    def test_capture_refuses_unexpected_failure_and_timeout(self):
        data=self.capture_data();run=data['runs']['run-1']
        with patch.object(self.service,'jobs_get',return_value=data):
            run['exit_code']=1
            with self.assertRaisesRegex(ValueError,'未通过'):
                self.service.assets_capture_context({'job_id':'fixture','figure_no':2})
            run['verdict']='expected_failure_ok'
            self.assertTrue(self.service.assets_capture_context({'job_id':'fixture','figure_no':2}))
            run['timed_out']=True
            with self.assertRaisesRegex(ValueError,'未通过'):
                self.service.assets_capture_context({'job_id':'fixture','figure_no':2})

    def test_original_resource_is_not_thumbnail(self):
        import io,base64
        file=self.root/'wide-original.png';Image.new('RGB',(2200,1600),'#2448DB').save(file)
        resource=self.service.call('resources.import',{'file_path':str(file)})
        for original,size in [(False,(962,700)),(True,(2200,1600))]:
            result=self.service.call('resources.preview',{'resource_id':resource['resource_id'],'original':original})
            raw=base64.b64decode(result['data_url'].split(',',1)[1])
            with Image.open(io.BytesIO(raw)) as image:
                self.assertEqual(image.size,size)

    def test_capture_refuses_changed_body_unapproved_plan_and_wrong_account(self):
        data=self.capture_data()
        with patch.object(self.service,'jobs_get',return_value=data):
            data['body']=data['body'].replace('print(1)','print(2)')
            with self.assertRaisesRegex(ValueError,'不一致'):self.service.assets_capture_context({'job_id':'fixture','figure_no':2})
            data['pending_approval']={'scope':'asset_plan'}
            with self.assertRaisesRegex(ValueError,'审核'):self.service.assets_capture_context({'job_id':'fixture','figure_no':2})
            data['article']['spec']['account_id']='other'
            with self.assertRaisesRegex(ValueError,'当前公众号'):self.service.assets_capture_context({'job_id':'fixture','figure_no':2})

    def test_capture_finish_refuses_stale_context_and_arbitrary_path(self):
        with patch.object(self.service,'assets_capture_context',return_value={'capture_hash':'current'}):
            with self.assertRaisesRegex(ValueError,'已变化'):self.service.assets_capture_finish({'capture_hash':'old'})
            with self.assertRaises(PermissionError):self.service.assets_capture_finish({'capture_hash':'current','file_path':str(self.file)})

    def test_manual_slot_import_archives_same_image_and_recommendation_guards_slot(self):
        from ice_agent.domain.types import AssetSlot
        from tests.test_workflow import demo_spec
        engine,_,store=self.service._app(demo=True)
        try:
            job_id,article_id=engine.create_job(demo_spec(),mode='demo')
            slot={**asdict(AssetSlot('slot-fixture',1,None,'cover','封面','Python 循环封面')),'article_id':article_id}
            store.upsert_slot(slot)
        finally:store.close()
        candidate=self.service.call('assets.import',{'job_id':job_id,'figure_no':1,'file_path':str(self.file),'archive_resource':True})
        resources=self.service.call('resources.list');resource=next(row for row in resources if row['resource_id']==candidate['resource_id'])
        self.assertEqual(resource['sha256'],candidate['sha256']);self.assertEqual(resource['usage'],'cover')
        self.assertTrue(self.service.call('jobs.get',{'job_id':job_id})['slots'][0]['valid'])
        transparent=self.root/'transparent.png';Image.new('RGBA',(20,20),(0,0,0,0)).save(transparent)
        with self.assertRaisesRegex(ValueError,'可见像素'):
            self.service.call('assets.import',{'job_id':job_id,'figure_no':1,'file_path':str(transparent),'archive_resource':True})
        data=self.service.call('jobs.get',{'job_id':job_id});self.assertEqual(data['slots'][0]['selected_candidate'],candidate['candidate_id'])
        rejected=next(row for row in data['slots'][0]['candidates'] if row['candidate_id']!=candidate['candidate_id'])
        self.assertNotEqual(rejected['review_status'],'accepted')
        result=self.service.call('resources.recommend',{'job_id':job_id,'figure_no':1})
        self.assertTrue(any(row['resource_id']==resource['resource_id'] for row in result['recommendations']))
        with self.assertRaisesRegex(ValueError,'图位已变化'):
            self.service.call('resources.use',{'job_id':job_id,'figure_no':1,'resource_id':resource['resource_id'],
                'content_hash':resource['content_hash'],'slot_hash':'outdated-slot'})
        adopted=self.service.call('resources.use',{'job_id':job_id,'figure_no':1,'resource_id':resource['resource_id'],
            'content_hash':resource['content_hash'],'slot_hash':data['slots'][0]['content_hash']})
        fresh=self.service.call('jobs.get',{'job_id':job_id})
        self.assertEqual(fresh['slots'][0]['selected_candidate'],adopted['candidate_id'])
        self.assertTrue(fresh['slots'][0]['valid'])
        # Selecting a different candidate changes the persisted slot. Its previous
        # review must be rejected even though the resource itself is unchanged.
        with self.assertRaisesRegex(ValueError,'图位已变化'):
            self.service.call('resources.use',{'job_id':job_id,'figure_no':1,'resource_id':resource['resource_id'],
                'content_hash':resource['content_hash'],'slot_hash':result['slot_hash']})


if __name__=='__main__':unittest.main()
