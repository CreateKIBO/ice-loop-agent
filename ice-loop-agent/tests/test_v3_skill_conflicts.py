"""v3.20 技能冲突检查：本地规则检查（指令文字相反要求、与检查规则不一致）与 AI 深入检查的结果规范化。"""
from __future__ import annotations

import unittest
from unittest import mock

from ice_agent.desktop_service import DesktopService
from ice_agent.skill_conflicts import _poles, ai_result, check
from ice_agent.skills import GENERAL_INSTRUCTIONS, ICE_INSTRUCTIONS
from tests import REPO, temp_dir


def skill(sid, name, text, kind='main', rules=None):
    return {'id': sid, 'name': name, 'instructions': text, 'kind': kind, 'rules': rules or {}}


class TestRuleCheck(unittest.TestCase):
    def test_negation_wins_within_a_sentence(self):
        for text, expected in [('用第一人称讲述。', ('person', 'first')), ('不要用第一人称。', ('person', 'third')),
                               ('可以适当使用表情点缀。', ('emoji', 'use')), ('不要使用表情。', ('emoji', 'avoid')),
                               ('结尾引导读者关注。', ('cta', 'want')), ('结尾不要号召关注。', ('cta', 'avoid')),
                               ('开头用一个问题吸引读者。', ('questions', 'ask')), ('开头不要用提问。', ('questions', 'avoid'))]:
            self.assertIn(expected, _poles(text), text)

    def test_presets_have_no_false_positive(self):
        result = check([skill('ice', 'ICE', ICE_INSTRUCTIONS), skill('gen', '通用', GENERAL_INSTRUCTIONS, 'addon')],
                       {'title_max_chars': 30, 'numbered_headings': True})
        self.assertEqual(result['conflicts'], [])
        self.assertIn('叙述人称', result['checked'])

    def test_text_and_rule_conflicts(self):
        result = check([skill('a', '主', '用第一人称讲述。标题不超过 20 字。全文控制在 1500 字以内。'),
                        skill('b', '辅', '不要用第一人称。正文不少于 3000 字。小标题不编号。', 'addon')],
                       {'title_max_chars': 30, 'numbered_headings': True, 'words_range': [2000, 4000]})
        found = {(c['kind'], c['label']) for c in result['conflicts']}
        self.assertEqual(found, {('text', '叙述人称'), ('rule', '标题字数'), ('rule', '篇幅'), ('rule', '小标题编号'), ('text', '篇幅')})
        person = next(c for c in result['conflicts'] if c['label'] == '叙述人称')
        self.assertEqual([(i['skill_name'], i['quote']) for i in person['items']], [('主', '用第一人称讲述。'), ('辅', '不要用第一人称。')])

    def test_same_skill_contradiction(self):
        result = check([skill('a', '主', '语气口语化，像朋友聊天。全文保持正式的语气。')])
        self.assertEqual(len(result['conflicts']), 1)
        self.assertIn('同一技能', result['conflicts'][0]['advice'])

    def test_ai_result_verifies_quotes(self):
        skills = [skill('a', '主', '用第一人称讲述。'), skill('b', '辅', '保持客观。', 'addon')]
        result = ai_result({'conflicts': [
            {'label': '人称', 'skill_a': '主', 'quote_a': '用第一人称讲述', 'skill_b': '辅', 'quote_b': '保持客观', 'severity': 'high'},
            {'label': '编造', 'skill_a': '主', 'quote_a': '不存在的话', 'skill_b': '检查规则', 'quote_b': 'x', 'severity': 'odd'},
            'bad'], 'notes': '两处'}, skills, 'm1')
        self.assertEqual([(c['verified'], c['severity']) for c in result['conflicts']], [(True, 'high'), (False, 'low')])
        self.assertEqual(result['model_id'], 'm1')
        self.assertEqual(ai_result(None, skills)['conflicts'], [])


class TestRpc(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-skill-conflicts-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service.call('bootstrap')['account']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def call(self, method, **params):
        return self.service.call(method, {'account_id': self.account['id'], **params})

    def test_check_saved_and_draft_combinations(self):
        saved = self.call('skills.check_conflicts')
        self.assertEqual(saved['conflicts'], [])
        self.assertEqual([s['id'] for s in saved['skills']], ['ice-writing'])
        draft = self.call('skills.check_conflicts', skills=[
            {'id': 'x', 'name': '甲', 'instructions': '用第一人称讲述。', 'rules': {}},
            {'id': 'y', 'name': '乙', 'instructions': '不要用第一人称。', 'kind': 'addon', 'rules': {}}])
        self.assertEqual(draft['conflicts'][0]['label'], '叙述人称')
        for bad in ([], [{'name': 1}], [{'name': 'a', 'instructions': '字' * 12001}]):
            with self.assertRaises(ValueError):
                self.call('skills.check_conflicts', skills=bad)

    def test_resolve_preview_carries_text_conflicts(self):
        state = self.call('skills.get')
        state['skills'] += [{'id': 'casual', 'name': '轻松口吻', 'instructions': '语气口语化，像朋友聊天。', 'rules': {}, 'kind': 'addon'},
                            {'id': 'formal', 'name': '正式口吻', 'instructions': '保持正式的语气。', 'rules': {}, 'kind': 'addon'}]
        state['active_addon_ids'] = ['casual', 'formal']
        self.service.call('skills.save', state)
        preview = self.call('skills.resolve')
        self.assertEqual([c['label'] for c in preview['text_conflicts']], ['语气'])

    def test_ai_check_calls_writer_once_and_normalizes(self):
        from ice_agent.llm.router import LLMResponse, RoleRouter
        seen = []

        def fake(router, request, **kwargs):
            seen.append((request.node, request.role, kwargs.get('max_attempts'), request.context['skills'][0]['name']))
            return LLMResponse(text='', data={'conflicts': [{'label': '人称', 'skill_a': 'ICE 写作方法', 'quote_a': '冷静、准确、有耐心',
                                                             'skill_b': '检查规则', 'quote_b': 'title_max_chars', 'severity': 'low'}]}, model_id='fake')
        with mock.patch.object(RoleRouter, 'generate', fake):
            result = self.call('skills.check_conflicts_ai')
        self.assertEqual(seen, [('skill_conflicts', 'writer', 1, 'ICE 写作方法')])
        self.assertEqual((result['method'], result['model_id'], result['conflicts'][0]['verified']), ('ai', 'fake', True))


if __name__ == '__main__':
    unittest.main()
