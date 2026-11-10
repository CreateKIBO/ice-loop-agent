"""v3.17 会话技能：助手会话可选技能；之后发出的消息按会话 → 会话系列 → 公众号解析；存为文章时带上。"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from ice_agent.creative_chat import CreativeChat
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import now_iso
from ice_agent.skills import selection_for_conversation
from tests import REPO, temp_dir


def capture_send(self, store, engine, cfg, account, params):
    return {'snapshot': cfg.profile['writing_skill_snapshot']}


class TestConversationSkills(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-conv-skills-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service.call('bootstrap')['account']
        state = self.call('skills.get')
        state['skills'] += [{'id': 'titles', 'name': '标题策略', 'instructions': '给三个备选标题。', 'rules': {}, 'kind': 'addon'},
                            {'id': 'story', 'name': '故事写法', 'instructions': '用一个人物贯穿。', 'rules': {}, 'kind': 'main'}]
        self.service.call('skills.save', state)
        self.conversation = self.service.call('chat.create', {'title': '讨论', 'request_id': 'c1'})
        self.cid = self.conversation['conversation']['id'] if 'conversation' in self.conversation else self.conversation['id']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def call(self, method, **params):
        return self.service.call(method, {'account_id': self.account['id'], **params})

    def test_binding_rpc_and_preview(self):
        preview = self.call('skills.resolve', conversation_id=self.cid)
        self.assertEqual((preview['main']['id'], preview['context']), ('ice-writing', 'conversation'))
        result = self.call('skills.conversation_binding', conversation_id=self.cid, binding={'main': 'story', 'addons': ['titles']})
        self.assertEqual((result['main']['id'], result['scope']), ('story', {'main': 'document', 'addons': 'document'}))
        self.assertEqual([a['id'] for a in result['addons']], ['titles'])
        draft = self.call('skills.resolve', conversation_id=self.cid, binding={'main': None})
        self.assertIsNone(draft['main'])
        for bad in ({'main': 'titles'}, {'addons': ['missing']}, {'x': 1}):
            with self.assertRaises(ValueError):
                self.call('skills.conversation_binding', conversation_id=self.cid, binding=bad)
        with self.assertRaises(ValueError):
            self.call('skills.conversation_binding', conversation_id='not-mine', binding=None)
        cleared = self.call('skills.conversation_binding', conversation_id=self.cid, binding=None)
        self.assertEqual(cleared['scope']['main'], 'account')

    def test_send_uses_conversation_binding_and_explicit_selection_wins(self):
        with mock.patch.object(CreativeChat, 'send', capture_send):
            plain = self.call('chat.send', conversation_id=self.cid, text='写点什么')['snapshot']
            self.assertEqual(plain['skill']['id'], 'ice-writing')
            self.assertNotIn('scope', plain)  # 没有会话设置也没有系列：与之前完全一样
            self.call('skills.conversation_binding', conversation_id=self.cid, binding={'main': 'story', 'addons': ['titles']})
            bound = self.call('chat.send', conversation_id=self.cid, text='继续')['snapshot']
            self.assertEqual((bound['skill']['id'], [a['id'] for a in bound['addons']]), ('story', ['titles']))
            explicit = self.call('chat.send', conversation_id=self.cid, text='另写', skill_selection={'binding': {'main': None}})['snapshot']
            self.assertIsNone(explicit['skill'])

    def test_conversation_series_binding_applies(self):
        columns = [c['code'] for c in self.account.get('columns', [])]
        if not columns:
            self.skipTest('账号没有栏目')
        created = self.service.call('chat.create', {'title': '系列讨论', 'series': columns[0], 'request_id': 'c2'})
        cid = created['conversation']['id'] if 'conversation' in created else created['id']
        state = self.call('skills.get')
        state['series_bindings'] = {columns[0]: {'main': 'story'}}
        self.service.call('skills.save', state)
        _, _, store = self.service._app()
        try:
            self.assertEqual(selection_for_conversation(store, self.account['id'], cid), {'series': columns[0], 'binding': None})
            self.assertIsNone(selection_for_conversation(store, self.account['id'], self.cid))
        finally:
            store.close()
        self.assertEqual(self.call('skills.resolve', conversation_id=cid)['scope']['main'], 'series')

    def test_save_as_article_carries_skills(self):
        self.call('skills.conversation_binding', conversation_id=self.cid, binding={'main': 'story'})
        _, _, store = self.service._app()
        try:
            store.conn.execute('INSERT INTO creative_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                               ('cand-1', self.cid, self.account['id'], '候选标题', '# 候选标题\n\n正文一段。', '{}', '{}', 'ready', None, '{}', now_iso()))
            snapshot = {'skill': {'id': 'story', 'name': '故事写法', 'version': 1}, 'addons': [{'id': 'titles', 'name': '标题策略', 'version': 1}]}
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                               ('msg-1', self.cid, 'assistant', '正文', 'completed',
                                json.dumps({'candidate_id': 'cand-1', 'request_snapshot': {'writing_profile': {'writing_skill_snapshot': snapshot}}}), now_iso()))
            store.conn.commit()
        finally:
            store.close()
        document = self.call('documents.from_candidate', candidate_id='cand-1')
        self.assertEqual(document['meta']['skill_binding'], {'main': 'story'})
        self.assertEqual([(s['name'], s['kind']) for s in document['meta']['generated_skills']], [('故事写法', 'main'), ('标题策略', 'addon')])


if __name__ == '__main__':
    unittest.main()
