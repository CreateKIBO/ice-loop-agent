import unittest
from ice_agent.genprompt import cover_prompt, body_diagram_prompt, reference_inputs, protect_generated_cover
from ice_agent.image_prompts import assemble


class PromptIdentityTests(unittest.TestCase):
    def brand(self):
        return {'name':'ICE Loop','preset':'ice-loop','colors':['#2448DB','#15191F','#F3F2ED'],
                'visual_references':[{'preset_asset':key,'title':key,'usage':'cover' if key.startswith('cover') else 'reference',
                    'resource_id':key} for key in ['cover-wk.png','cover-jv.png','wordmark.png','avatar.png','cover-py.png','cover-ai.png','overview.png']]}

    def test_matching_template_is_first_and_identity_is_second(self):
        for series in ['PY','JV','AI','WK']:
            rows=reference_inputs(self.brand(),series,'cover')
            self.assertEqual([r['preset_asset'] for r in rows],['cover-'+series.lower()+'.png','avatar.png'])
            self.assertEqual([r['image'] for r in rows],[1,2])

    def test_cover_cannot_be_redesigned_by_planner_or_lose_words(self):
        prompt=assemble({'kind':'cover','caption':'封面'},'循环入门：让电脑替你重复干活','PY',5,self.brand(),
                        'Add a robot and change the logo to a horizontal mark',['错误标题'])
        self.assertTrue(prompt.startswith('Edit image 1'))
        self.assertIn('循环入门：让电脑替你重复干活',prompt)
        self.assertIn('PY / 005',prompt)
        self.assertIn('intertwined double-O crossover',prompt)
        self.assertIn('original landscape aspect ratio',prompt)
        self.assertNotIn('Add a robot',prompt)
        self.assertNotIn('错误标题',prompt)
        self.assertNotIn('cover-wk',prompt)

    def test_cover_preserves_verified_title_split(self):
        prompt=assemble({'kind':'cover'},'什么是vibe coding','AI',1,self.brand(),labels=['什么是','vibe coding'])
        self.assertIn('exactly "什么是" and "vibe coding"',prompt)
        self.assertIn('05-封面-AI-001.png',prompt)

    def test_body_uses_identity_for_style_not_large_logo_and_has_exact_labels(self):
        prompt=body_diagram_prompt('需求到验证',['需求','验证'],'Two boxes left to right, connected by a thin arrow.',brand=self.brand())
        self.assertTrue(prompt.startswith('Use case:'))
        self.assertIn('do not reproduce a large logo',prompt)
        self.assertIn('exactly "需求"',prompt)
        self.assertIn('Two boxes left to right',prompt)
        self.assertIn('4:3',prompt)
        self.assertNotIn('03-封面-Python',prompt)

    def test_another_publication_does_not_receive_ice_assets(self):
        brand={'name':'生活札记','preset':'general','colors':['#AABBCC'],'visual_references':[]}
        self.assertEqual(reference_inputs(brand,'LIFE'),[])
        prompt=cover_prompt('LIFE',['慢慢读书'],'LIFE / 002','',brand=brand)
        self.assertIn('#AABBCC',prompt)
        self.assertNotIn('ICE Loop',prompt)
        self.assertNotIn('double-O',prompt)

    def test_generic_cover_uses_uploaded_template(self):
        brand={'name':'生活札记','preset':'general','visual_references':[{'title':'LIFE 封面','resource_id':'a','usage':'cover'}]}
        prompt=cover_prompt('LIFE',['慢慢读书'],'LIFE / 002','',brand=brand)
        self.assertTrue(prompt.startswith('Edit image 1'))
        self.assertIn('生活札记',prompt)
        self.assertNotIn('ICE / LOOP',prompt)

    def test_fallback_names_point_to_approved_originals(self):
        rows=reference_inputs({'name':'ICE Loop'},'AI')
        self.assertEqual([r['filename'] for r in rows],['05-封面-AI-001.png','01-头像-信号蓝.png'])

    def test_generated_chat_cover_is_protected_but_diagram_and_original_list_are_unchanged(self):
        raw=['Create a 16:9 cover with a robot','Use case: infographic-diagram; flow arrows.']
        result=protect_generated_cover(raw,'循环入门','PY',5,self.brand())
        self.assertTrue(result[0].startswith('Edit image 1'))
        self.assertEqual(raw[0],'Create a 16:9 cover with a robot')
        self.assertEqual(result[1],raw[1])
        self.assertEqual(protect_generated_cover([raw[1]],'正文图','PY',5,self.brand()),[raw[1]])

    def test_general_publication_named_ice_loop_does_not_inherit_preset(self):
        self.assertEqual(reference_inputs({'name':'ICE Loop','preset':'general','visual_references':[]},'PY'),[])
