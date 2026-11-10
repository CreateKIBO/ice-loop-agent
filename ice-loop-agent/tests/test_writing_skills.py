import copy
import json
import time
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.llm.router import LLMResponse, RoleRouter
from ice_agent.prompts import render
from ice_agent.rules import run_all_checks
from tests import REPO, temp_dir


class WritingSkillTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('writing-skills-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service.call('bootstrap')['account']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def get(self):
        return self.service.call('skills.get', {'account_id': self.account['id']})

    def save(self, state):
        return self.service.call('skills.save', state)

    def profile(self):
        _, cfg, store = self.service._app()
        try:
            return copy.deepcopy(cfg.profile)
        finally:
            store.close()

    def wait(self, cid):
        for _ in range(200):
            data = self.service.call('chat.get', {'conversation_id': cid})
            if not any(m['status'] == 'streaming' for m in data['messages']):
                return data['messages'][-1]
            time.sleep(.02)
        self.fail('chat did not finish')

    def test_defaults_and_edit_are_versioned_and_persisted(self):
        state = self.get()
        self.assertEqual(state['active_skill_id'], 'ice-writing')
        ice = next(s for s in state['skills'] if s['id'] == 'ice-writing')
        ice['name'] = '我的新版方法'
        ice['instructions'] = '用三个真实生活场景组织文章，不要导师腔。'
        state = self.save(state)
        saved = next(s for s in state['skills'] if s['id'] == 'ice-writing')
        self.assertEqual(saved['version'], 2)
        profile = self.profile()
        for stage in ('outline', 'draft', 'style_review'):
            self.assertIn(ice['instructions'], render(stage, profile=profile))
        self.service.close()
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.assertEqual(self.get(), state)

    def test_default_ice_retains_existing_method_checks(self):
        from ice_agent.accounts import profile_from_account
        prior, current = profile_from_account(self.account), self.profile()
        for key in ('banned_ai_phrases', 'banned_patterns', 'banned_punctuation', 'wk_extra_rules'):
            self.assertEqual(current[key], prior[key], key)
        for key, value in prior['article'].items():
            self.assertEqual(current['article'][key], value, key)
        self.assertTrue(current['article']['numbered_headings'])

    def test_turning_off_removes_author_checks_but_keeps_factual_gates(self):
        text = '# 散步\n\n“今天——沿河走走。”\n'
        enabled = run_all_checks(text, self.profile())
        self.assertIn('h2.ending', {f['rule'] for f in enabled['report']['blocking']})
        state = self.get(); state['active_skill_id'] = None; self.save(state)
        profile = self.profile()
        report = run_all_checks(text, profile)
        self.assertTrue(report['passed'], report)
        self.assertNotIn('最后一个 ## 固定', render('outline', profile=profile))
        self.assertNotIn('四层自检终审（khazix', render('style_review', profile=profile))
        facts = run_all_checks('# 费用\n\n每月收费99元。', profile)
        self.assertIn('fact.high_risk', {f['rule'] for f in facts['report']['blocking']})
        self.assertEqual(profile['brand']['name'], self.account['name'])

    def test_custom_skill_rules_and_prompt_use_same_snapshot(self):
        state = self.get()
        state['skills'].append({'id': 'story', 'name': '故事', 'instructions': '先讲一次具体经历，再给结论。',
                                'rules': {'required_ending_heading': '尾声', 'code_blocks': [0, 0], 'title_max_chars': 12}, 'version': 900})
        state['active_skill_id'] = 'story'
        saved = self.save(state)
        self.assertEqual(saved['skills'][-1]['version'], 1)
        profile = self.profile()
        self.assertIn('先讲一次具体经历', render('draft', profile=profile))
        check = run_all_checks('# 故事\n\n开头。\n\n## 尾声\n\n结束。', profile)
        self.assertTrue(check['passed'], check)
        check = run_all_checks('# 故事\n\n开头。\n\n## 结束\n\n结束。', profile)
        self.assertIn('h2.ending', {f['rule'] for f in check['report']['blocking']})

    def test_conflicting_save_and_invalid_rules_do_not_overwrite(self):
        first = self.get(); stale = copy.deepcopy(first)
        first['active_skill_id'] = None
        saved = self.save(first)
        with self.assertRaisesRegex(ValueError, '其他窗口'):
            self.save(stale)
        for bad in ({'execute': 'anything'}, {'max_dash': True}, {'numbered_headings': 1}, {'ending_triad': {'unknown': 'x'}}):
            candidate = copy.deepcopy(saved); candidate['skills'][0]['rules'] = bad
            with self.assertRaises(ValueError):
                self.save(candidate)
            self.assertEqual(self.get(), saved)

    def test_account_scope_and_removed_default_stays_removed(self):
        state = self.get()
        state['skills'] = [s for s in state['skills'] if s['id'] != 'ice-writing']
        state['active_skill_id'] = None
        saved = self.save(state)
        self.assertNotIn('ice-writing', [s['id'] for s in self.get()['skills']])
        other = self.service.call('accounts.save', {'account': {**self.account, 'id': None, 'name': '另一个号', 'preset': 'general'}})['account']
        self.assertNotEqual(other['id'], self.account['id'])
        with self.assertRaisesRegex(ValueError, '公众号已切换'):
            self.save(saved)
        new = self.service.call('skills.get', {'account_id': other['id']})
        self.assertEqual(new['active_skill_id'], 'general-writing')
        self.service.call('accounts.switch', {'account_id': self.account['id']})
        self.assertEqual(self.get(), saved)

    def test_new_jobs_freeze_original_skill_settings(self):
        engine, cfg, store = self.service._app()
        try:
            frozen = copy.deepcopy(cfg.profile['writing_skill_snapshot'])
            job, _ = engine.create_job({'series': 'PY', 'episode': 1, 'topic': '技能快照', 'account_id': self.account['id']})
        finally:
            store.close()
        state = self.get(); state['active_skill_id'] = None; self.save(state)
        self.assertIsNone(self.profile()['writing_skill_snapshot']['skill'])
        _, cfg, store = self.service._job_app(job)
        try:
            self.assertEqual(cfg.profile['writing_skill_snapshot'], frozen)
        finally:
            store.close()

    def test_chat_retry_uses_saved_skill_after_settings_change(self):
        state = self.get(); state['active_skill_id'] = 'general-writing'
        state['skills'][0]['instructions'] = '独特技能标记甲：先观察后总结。'
        self.save(state)
        cid = self.service.call('chat.create', {})['conversation']['id']
        seen = []
        def fail(router, req, **kwargs):
            seen.append(req)
            raise RuntimeError('owned test failure')
        with patch.object(RoleRouter, 'generate', fail):
            self.service.call('chat.send', {'conversation_id': cid, 'text': '讨论一次散步'})
            failed = self.wait(cid)
        self.assertEqual(failed['status'], 'failed')
        state = self.get(); state['active_skill_id'] = None; self.save(state)
        def succeed(router, req, **kwargs):
            seen.append(req)
            return LLMResponse('完成讨论', model_id='offline-test')
        with patch.object(RoleRouter, 'generate', succeed):
            self.service.call('chat.send', {'conversation_id': cid, 'retry_message_id': failed['id']})
            done = self.wait(cid)
        self.assertEqual(done['status'], 'completed', done)
        self.assertIn('独特技能标记甲', seen[-1].system)
        self.assertEqual(seen[0].context['publication'], seen[-1].context['publication'])
        self.assertIsNone(self.profile()['writing_skill_snapshot']['skill'])

    def test_rule_sources_still_override_skill_rules_explicitly(self):
        self.service.call('rules.save', {'name': '本次标题上限', 'kind': 'task', 'text': '最多18字', 'rules': {'title_max_chars': 18}})
        self.assertEqual(self.profile()['article']['title_max_chars'], 18)

    def test_agent_rule_tool_reads_effective_or_frozen_skill(self):
        from ice_agent.agent.registry import AgentContext, ToolExecutor
        frozen = self.profile()
        state = self.get(); state['active_skill_id'] = None; self.save(state)
        ctx = AgentContext(account_id=self.account['id'], account=self.account, service=self.service,
                           store_factory=self.service._app_store_factory(), run_id='skills-test')
        executor = ToolExecutor()
        current = executor.execute(ctx, 'resolve_brand_rules', {})
        self.assertIsNone(current['writing_skill'])
        self.assertEqual(current['article_rules']['required_ending_heading'], '')
        ctx.writing_profile = frozen
        original = executor.execute(ctx, 'resolve_brand_rules', {})
        self.assertEqual(original['writing_skill']['id'], 'ice-writing')
        self.assertEqual(original['article_rules']['required_ending_heading'], '写在最后')
