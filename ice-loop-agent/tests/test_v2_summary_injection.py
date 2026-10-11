"""D：会话摘要注入真实请求——较早轮次摘要、近期原文、范围与 hash 记进 manifest。离线。"""
import json
import time
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from ice_agent.llm.router import LLMResponse, RoleRouter
from tests import REPO, temp_dir


class SummaryInjectionTests(unittest.TestCase):
    def setUp(self):
        self.service = DesktopService(REPO, temp_dir('summary-inject-') / 'runtime', auto_consumer=False)
        self.service.call('bootstrap')
        self.cid = self.service.call('chat.create', {})['conversation']['id']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def send(self, text, **patch_kwargs):
        with patch.object(RoleRouter, 'generate', autospec=True, **patch_kwargs) as generate:
            self.service.call('chat.send', {'conversation_id': self.cid, 'text': text, 'mode': 'discuss'})
            for _ in range(250):
                rows = self.service.call('chat.get', {'conversation_id': self.cid})['messages']
                if not any(row['status'] == 'streaming' for row in rows):
                    if rows and rows[-1]['status'] != 'completed':
                        self.fail(rows[-1]['content'][:300])
                    return generate
                time.sleep(.02)
        self.fail('reply did not finish')

    def test_short_conversation_sends_raw_history(self):
        captured = {}

        def fake(_router, req, **_kwargs):
            captured['history'] = list(req.history)
            return LLMResponse('好的')

        self.send('第一轮', side_effect=fake)
        self.send('第二轮', side_effect=fake)
        # 请求在本轮用户消息落库前构建，所以历史只含此前已完成的轮次。
        roles = [item['role'] for item in captured['history']]
        self.assertEqual(roles, ['user', 'assistant'])
        self.assertTrue(all('摘要' not in item['content'] for item in captured['history']))

    def test_summary_replaces_older_turns_and_records_manifest(self):
        for index in range(4):
            self.send(f'问题{index}', return_value=LLMResponse(f'回答{index}'))
        self.service.call('chat.summary', {'conversation_id': self.cid})
        captured = {}

        def fake(_router, req, **_kwargs):
            captured['history'] = list(req.history)
            return LLMResponse('收尾')

        self.send('最近的问题', side_effect=fake)
        history = captured['history']
        self.assertTrue(history[0]['content'].startswith('[较早对话摘要'))
        # 本轮请求在落库前构建：最近 6 条已完成原文 + 1 条摘要，当前问题走 prompt。
        self.assertEqual(len(history), 7)
        self.assertIn('回答3', history[-1]['content'])
        rows = self.service.call('chat.get', {'conversation_id': self.cid})['messages']
        manifest = rows[-1]['metadata']['summary_manifest']
        self.assertFalse(manifest['stale'])
        self.assertEqual(manifest['recent_count'], 6)
        self.assertGreater(manifest['covered_count'], 0)
        self.assertEqual(len(manifest['content_hash']), 64)

    def test_stale_summary_falls_back_to_raw_history(self):
        for index in range(4):
            self.send(f'问题{index}', return_value=LLMResponse(f'回答{index}'))
        self.service.call('chat.summary', {'conversation_id': self.cid})
        _, _, store = self.service._app()
        try:
            row = store.conn.execute(
                "SELECT digest_json FROM conversation_summaries WHERE conversation_id=?",
                (self.cid,)).fetchone()
            tampered = json.loads(row['digest_json'])
            tampered['last_user_intent'] = '被替换的内容'
            digest = json.dumps(tampered, ensure_ascii=False)
            store.conn.execute(
                "UPDATE conversation_summaries SET digest_json=?, content_hash=? WHERE conversation_id=?",
                (digest, sha256_text('not-the-digest'), self.cid))
            store.conn.commit()
        finally:
            store.close()
        captured = {}

        def fake(_router, req, **_kwargs):
            captured['history'] = list(req.history)
            return LLMResponse('照常用原文')

        self.send('继续', side_effect=fake)
        self.assertTrue(all(not item['content'].startswith('[较早对话摘要') for item in captured['history']))
        rows = self.service.call('chat.get', {'conversation_id': self.cid})['messages']
        manifest = rows[-1]['metadata']['summary_manifest']
        self.assertTrue(manifest['stale'])


if __name__ == '__main__':
    unittest.main()
