import copy
import json
import unittest
from unittest.mock import patch

from PIL import Image

from ice_agent.accounts import ICE_VISUAL_BRIEF
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from ice_agent.llm.adapters import make_adapter
from ice_agent.llm.errors import CapabilityMismatch
from ice_agent.llm.router import LLMResponse
from tests import REPO, temp_dir
from tests.test_router import FakeTransport, make_profile


class TestImagePrompts(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('prompt-');self.s=DesktopService(REPO,self.root,self.root/'articles')
        source=self.root/'article.md';source.write_text('# PY/012 循环与累加\n\n逐步累加的结果是15。\n\n![图1：累加流程](待配图：生图)\n\n![图2：运行截图](待配图：截图)\n',encoding='utf-8')
        self.job=self.s.call('supplements.create',{'file_path':str(source)})['job_id']
        self.file=self.root/'asset.png';Image.new('RGB',(80,50),'#2448DB').save(self.file)

    def tearDown(self):self.s.close()

    def params(self, figure=1):
        data=self.s.call('jobs.get',{'job_id':self.job});slot=next(s for s in data['slots'] if s['figure_no']==figure)
        return {'job_id':self.job,'figure_no':figure,'account_id':'ice-loop','content_hash':slot['content_hash'],'body_hash':data['body_hash']}

    def test_preset_import_uses_original_bytes_and_is_idempotent(self):
        first=self.s.call('resources.import_style',{'account_id':'ice-loop'})
        second=self.s.call('resources.import_style',{'account_id':'ice-loop'})
        self.assertEqual([r['resource_id'] for r in first['resources']],[r['resource_id'] for r in second['resources']])
        self.assertEqual(len(self.s.call('resources.list')),7)
        brand=self.s._app();engine,cfg,store=brand
        try:self.assertEqual(len(cfg.profile['brand']['visual_references']),7)
        finally:store.close()
        for r in first['resources']:
            original=REPO/'ice_agent/resources/visual_presets/ice-loop'/r['preset_asset']
            self.assertEqual(original.read_bytes(),__import__('pathlib').Path(r['file_path']).read_bytes())
        with self.assertRaises(ValueError):self.s.call('resources.import_style',{'account_id':'another'})

    def test_prompt_edit_retains_selected_image_and_stale_edits_are_rejected(self):
        self.s.call('assets.import',{'job_id':self.job,'figure_no':1,'file_path':str(self.file)})
        before=self.s.call('jobs.get',{'job_id':self.job})['slots'][0]['selected_candidate'];params=self.params()
        self.s.call('prompts.save',{**params,'prompt':'My manual prompt'})
        slot=self.s.call('jobs.get',{'job_id':self.job})['slots'][0]
        self.assertEqual(slot['selected_candidate'],before);self.assertTrue(slot['valid'])
        self.assertEqual(slot['prompt'],'My manual prompt');self.assertTrue(slot['prompt_history'])
        with self.assertRaisesRegex(ValueError,'已变化'):self.s.call('prompts.save',{**params,'prompt':'late edit'})

    def test_reference_upload_order_matches_prompt_and_stays_account_scoped(self):
        self.s.call('resources.import_style',{'account_id':'ice-loop'})
        rows=self.s.call('prompts.references',self.params())['references']
        self.assertTrue(rows)
        self.assertTrue(all(row['resource_id'] for row in rows))
        self.assertNotIn('cover-jv.png',[row['preset_asset'] for row in rows])
        with self.assertRaisesRegex(ValueError,'公众号已切换'):
            self.s.call('prompts.references',{**self.params(),'account_id':'other'})

    def test_generation_reads_article_and_marked_reference_without_mutating_prompt(self):
        resource=self.s.call('resources.import',{'file_path':str(self.file)})
        self.s.call('resources.update',{'resource_id':resource['resource_id'],'content_hash':resource['content_hash'],
            'title':'我的参考图','description':'左侧标题，右侧循环路径','tags':[],'usage':'reference','style_reference':True})
        before=self.s.call('jobs.get',{'job_id':self.job})['slots'][0]['prompt']
        def generate(router,req,**kwargs):
            self.assertIn('逐步累加',req.context['article_excerpt'])
            self.assertEqual(req.context['publication']['visual_references'][0]['description'],'左侧标题，右侧循环路径')
            self.assertEqual(req.images,[])
            return LLMResponse(text='',data={'figures':[{'figure_no':1,'layout':'Draw five boxes progressing left to right, with accumulated totals below them.','exact_text':['累加','15']}]},model_id='fixture')
        with patch('ice_agent.llm.router.RoleRouter.generate',new=generate):result=self.s.call('prompts.generate',self.params())
        self.assertIn('five boxes',result['prompt']);self.assertIn('#2448DB',result['prompt']);self.assertIn('我的参考图',result['prompt'])
        self.assertEqual(self.s.call('jobs.get',{'job_id':self.job})['slots'][0]['prompt'],before)

    def test_late_generation_after_article_edit_is_discarded(self):
        def generate(router,req,**kwargs):
            engine,_,store=self.s._job_app(self.job)
            try:
                state=engine._load_state(self.job);state['integrated_md']+='\n已修改正文\n';engine._save_state(self.job,state)
            finally:store.close()
            return LLMResponse(text='',data={'figures':[{'figure_no':1,'layout':'Boxes and arrows','exact_text':[]}]})
        with patch('ice_agent.llm.router.RoleRouter.generate',new=generate):
            with self.assertRaisesRegex(ValueError,'已变化'):self.s.call('prompts.generate',self.params())

    def test_screenshots_and_other_accounts_cannot_generate_or_save_prompts(self):
        for params in [self.params(2),{**self.params(),'account_id':'other'}]:
            with patch('ice_agent.llm.router.RoleRouter.generate') as generate:
                with self.assertRaises(ValueError):self.s.call('prompts.generate',params)
                generate.assert_not_called()

    def test_deepseek_image_contract_and_text_only_model_guard(self):
        before=copy.deepcopy(self.s.settings['profiles'])
        self.s.call('vision.save',{'provider':'deepseek','model_id':'deepseek-flash'})
        self.assertEqual(self.s.settings['profiles'],before)
        with self.assertRaises(ValueError):self.s._vision_profile()
        with patch('ice_agent.visual_assets.probe_vision',return_value={'model':'deepseek-flash'}):self.s.call('vision.probe')
        self.assertEqual(self.s._vision_profile().capabilities['vision'],'verified')
        self.s.settings['profiles']['deepseek']['base_url']='https://new-endpoint.example'
        with self.assertRaisesRegex(ValueError,'接口已变化'):self.s._vision_profile()
        message=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,YQ=='}}]}]
        transport=FakeTransport([{'ok':'seen'}]);make_adapter(make_profile('deepseek'),transport).chat(message)
        self.assertEqual(transport.calls[0]['messages'],message)
        with self.assertRaises(CapabilityMismatch):make_adapter(make_profile('deepseek',model_id='deepseek-v4-pro'),transport).chat(message)
        self.assertEqual(len(transport.calls),1)
        with self.assertRaises(ValueError):self.s.call('vision.save',{'provider':'deepseek','model_id':'deepseek-v4-pro'})


if __name__=='__main__':unittest.main()
