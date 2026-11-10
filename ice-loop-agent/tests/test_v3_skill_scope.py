"""v3.16 写作技能组合与作用域：主技能 + 辅助技能；本篇 → 系列 → 公众号；规则合并与冲突；本篇使用。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from ice_agent.desktop_service import DesktopService
from ice_agent.prompts import render
from ice_agent.skills import merge_rules, normalize_selection, selection_for_document
from tests import REPO, temp_dir
from tests.test_v3_generation import FakeChat


class Chat(FakeChat):
    METHODS: frozenset = frozenset()  # 只替换文章起草用到的会话；其他 RPC 正常路由


def addon(sid, name, instructions, rules=None):
    return {'id': sid, 'name': name, 'instructions': instructions, 'rules': rules or {}, 'kind': 'addon'}


class Fixture(unittest.TestCase):
    def setUp(self):
        FakeChat.sent, FakeChat.created = [], []
        self.root = temp_dir('v3-skill-scope-')
        self.env = mock.patch.dict(os.environ, {'ICE_LEGACY_CODE_EXECUTION': '0'})
        self.env.start()
        self.patch = mock.patch('ice_agent.creative_chat.CreativeChat', Chat)
        self.patch.start()
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service.call('bootstrap')['account']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()
        self.patch.stop()
        self.env.stop()

    def call(self, method, **params):
        return self.service.call(method, {'account_id': self.account['id'], **params})

    def setup_skills(self, **extra):
        state = self.call('skills.get')
        state['skills'] += [addon('titles', '标题策略', '标题给出三个备选，具体不夸张。', {'title_max_chars': 26}),
                            addon('checklist', '审阅清单', '交稿前逐条核对事实与数据来源。', {'numbered_headings': False}),
                            {'id': 'story', 'name': '故事写法', 'instructions': '用一个人物的经历贯穿全文。', 'rules': {}, 'kind': 'main'}]
        state.update(extra)
        return self.service.call('skills.save', state)

    def profile(self, selection=None):
        _, cfg, store = self.service._app(skill_selection=selection)
        try:
            return cfg.profile
        finally:
            store.close()


class TestCombination(Fixture):
    def test_kinds_and_account_addons(self):
        state = self.setup_skills(active_addon_ids=['titles'])
        self.assertEqual({s['id']: s['kind'] for s in state['skills']}['titles'], 'addon')
        self.assertEqual(state['active_addon_ids'], ['titles'])
        snapshot = self.profile()['writing_skill_snapshot']
        self.assertEqual(snapshot['skill']['id'], 'ice-writing')
        self.assertEqual([a['id'] for a in snapshot['addons']], ['titles'])
        text = render('draft', profile=self.profile())
        self.assertIn('标题给出三个备选', text)
        self.assertIn('主技能优先', text)
        bad = self.call('skills.get')
        bad['active_skill_id'] = 'titles'
        with self.assertRaisesRegex(ValueError, '辅助技能不能作为主技能'):
            self.service.call('skills.save', bad)
        bad = self.call('skills.get')
        bad['active_addon_ids'] = ['story']
        with self.assertRaisesRegex(ValueError, '不是辅助技能'):
            self.service.call('skills.save', bad)

    def test_main_rules_win_and_addon_conflicts_are_rejected(self):
        state = self.setup_skills()
        skills = {s['id']: s for s in state['skills']}
        rules, conflicts = merge_rules(skills['ice-writing'], [skills['titles'], skills['checklist']])
        self.assertEqual(rules['title_max_chars'], skills['ice-writing']['rules']['title_max_chars'])
        self.assertEqual({c['rule'] for c in conflicts if c['kind'] == 'main'}, {'title_max_chars', 'numbered_headings'})
        # 两个辅助技能对同一规则要求不同：保存时拒绝，不按先后静默覆盖
        state['skills'].append(addon('short-titles', '短标题', '标题更短。', {'title_max_chars': 16}))
        state['active_addon_ids'] = ['titles', 'short-titles']
        with self.assertRaisesRegex(ValueError, 'title_max_chars'):
            self.service.call('skills.save', state)
        # 主技能没设的规则由辅助技能补上，并进入程序化检查
        state = self.call('skills.get')
        state.update(active_skill_id='story', active_addon_ids=['titles'])
        self.service.call('skills.save', state)
        self.assertEqual(self.profile()['article']['title_max_chars'], 26)

    def test_omitted_bindings_are_kept_and_removed_skills_dropped(self):
        state = self.setup_skills(active_addon_ids=['titles', 'checklist'],
                                  series_bindings={'周刊': {'main': 'story', 'addons': ['checklist']}})
        del state['active_addon_ids'], state['series_bindings']
        state = self.service.call('skills.save', state)  # 旧界面不带这两项：沿用
        self.assertEqual(state['active_addon_ids'], ['titles', 'checklist'])
        state['skills'] = [s for s in state['skills'] if s['id'] != 'checklist']
        del state['active_addon_ids'], state['series_bindings']
        state = self.service.call('skills.save', state)
        self.assertEqual(state['active_addon_ids'], ['titles'])
        self.assertEqual(state['series_bindings'], {'周刊': {'main': 'story', 'addons': []}})
        with self.assertRaises(ValueError):
            state['series_bindings'] = {'周刊': {'main': 'missing'}}
            self.service.call('skills.save', state)


class TestScope(Fixture):
    def test_document_then_series_then_account(self):
        self.setup_skills(active_addon_ids=['titles'], series_bindings={'周刊': {'main': 'story'}})
        account = self.profile()['writing_skill_snapshot']
        self.assertEqual(account['skill']['id'], 'ice-writing')
        series = self.profile({'series': '周刊'})['writing_skill_snapshot']
        self.assertEqual((series['skill']['id'], series['scope']), ('story', {'main': 'series', 'addons': 'account'}))
        self.assertEqual([a['id'] for a in series['addons']], ['titles'])  # 系列没改辅助技能：沿用公众号
        document = self.profile({'series': '周刊', 'binding': {'main': None, 'addons': ['checklist']}})['writing_skill_snapshot']
        self.assertIsNone(document['skill'])
        self.assertEqual([a['id'] for a in document['addons']], ['checklist'])
        self.assertEqual(document['scope'], {'main': 'document', 'addons': 'document'})
        missing = self.profile({'binding': {'main': 'gone'}})['writing_skill_snapshot']
        self.assertEqual(missing['skill']['id'], 'ice-writing')
        self.assertTrue(any('已移除' in n for n in missing['notices']))
        with self.assertRaises(ValueError):
            normalize_selection({'binding': {'main': 1}})

    def test_document_binding_rpc_and_preview(self):
        self.setup_skills(series_bindings={'周刊': {'main': 'story'}})
        created = self.call('documents.create', kind='blank', title='一篇')
        doc_id = created['document_id']
        self.call('documents.update_meta', document_id=doc_id, series='周刊')
        preview = self.call('skills.resolve', document_id=doc_id)
        self.assertEqual((preview['main']['id'], preview['scope']['main']), ('story', 'series'))
        draft = self.call('skills.resolve', document_id=doc_id, binding={'addons': ['titles']})  # 未保存的预览
        self.assertEqual([a['id'] for a in draft['addons']], ['titles'])
        result = self.call('documents.skill_binding', document_id=doc_id, binding={'main': 'ice-writing', 'addons': ['titles']})
        self.assertEqual((result['main']['id'], result['scope']['main']), ('ice-writing', 'document'))
        self.assertEqual(self.call('documents.get', document_id=doc_id)['meta']['skill_binding'],
                         {'main': 'ice-writing', 'addons': ['titles']})
        _, _, store = self.service._app()
        try:
            self.assertEqual(selection_for_document(store, self.account['id'], doc_id)['series'], '周刊')
        finally:
            store.close()
        for bad in ({'main': 'titles'}, {'addons': ['story']}, {'main': 'nope'}, {'other': 1}):
            with self.assertRaises(ValueError):
                self.call('documents.skill_binding', document_id=doc_id, binding=bad)
        cleared = self.call('documents.skill_binding', document_id=doc_id, binding=None)
        self.assertEqual(cleared['scope']['main'], 'series')
        self.assertNotIn('skill_binding', self.call('documents.get', document_id=doc_id)['meta'])

    def test_ai_draft_sends_document_selection(self):
        self.setup_skills()
        detail = self.call('documents.ai_draft_start', brief='写一篇家庭收纳经验', request_id='s1',
                           skill_binding={'main': 'story', 'addons': ['titles']})
        self.assertEqual(detail['meta']['skill_binding'], {'main': 'story', 'addons': ['titles']})
        self.assertEqual(FakeChat.sent[0]['skill_selection'], {'binding': {'main': 'story', 'addons': ['titles']}})
        plain = self.call('documents.ai_draft_start', brief='另一篇不选技能', request_id='s2')
        self.assertNotIn('skill_binding', plain['meta'])
        self.assertNotIn('skill_selection', FakeChat.sent[1])
        self.call('documents.ai_guided_start', brief='引导模式也能选', request_id='g1', skill_binding={'main': None})
        self.assertEqual(FakeChat.sent[2]['skill_selection'], {'binding': {'main': None}})
        with self.assertRaises(ValueError):
            self.call('documents.ai_draft_start', brief='错误的技能', request_id='s3', skill_binding={'main': 'titles'})


class TestPackageKind(unittest.TestCase):
    def test_kind_round_trips_through_markdown(self):
        from ice_agent.skill_packages import parse, to_markdown
        exported = to_markdown({'id': 'titles', 'name': '标题策略', 'version': 2, 'kind': 'addon', 'instructions': '给三个备选。', 'rules': {}})
        self.assertIn('kind: addon', exported['markdown'])
        self.assertEqual(parse({'text': exported['markdown']})['skill']['kind'], 'addon')
        self.assertEqual(parse({'text': '普通指令'})['skill']['kind'], 'main')


if __name__ == '__main__':
    unittest.main()
