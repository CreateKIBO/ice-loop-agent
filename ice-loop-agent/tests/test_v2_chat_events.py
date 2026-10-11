"""C1：创作会话把真实步骤写入持久事件流，events.poll 可按游标补取。离线 mock 模型。"""
import time
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.events import EventBroker, dedupe_by_sequence
from ice_agent.llm.router import LLMResponse, RoleRouter
from tests import REPO, temp_dir

EDIT = {'reply': '已改写', 'title': '新标题', 'body': '# 新标题\n\n正文。\n\n## 写在最后\n待核验。',
        'prompts': []}


class ChatEventTests(unittest.TestCase):
    def setUp(self):
        self.service = DesktopService(REPO, temp_dir('chat-events-'), auto_consumer=False)
        self.service.call('bootstrap')
        self.cid = self.service.call('chat.create', {})['conversation']['id']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def send(self, mode='discuss', **patch_kwargs):
        with patch.object(RoleRouter, 'generate', **patch_kwargs):
            message = self.service.call('chat.send', {'conversation_id': self.cid, 'text': '写点什么', 'mode': mode})
            for _ in range(250):
                rows = self.service.call('chat.get', {'conversation_id': self.cid})['messages']
                if not any(row['status'] == 'streaming' for row in rows):
                    return message['message_id']
                time.sleep(.02)
        self.fail('reply did not finish')

    def events(self, after=0):
        return self.service.call('events.poll', {'stream_id': 'chat:' + self.cid, 'after': after})

    def test_discussion_turn_records_real_phases_in_order(self):
        turn = self.send(return_value=LLMResponse('可以从读者痛点切入。'))
        result = self.events()
        events = result['events']
        self.assertEqual([e['sequence'] for e in events], list(range(1, len(events) + 1)))
        self.assertEqual(result['latest'], events[-1]['sequence'])
        self.assertTrue(all(e['payload']['turn_id'] == turn for e in events))
        summary = [(e['type'], e['payload'].get('status') if e['type'] == 'turn.finished'
                    else e['payload'].get('phase')) for e in events]
        self.assertEqual(summary[0][0], 'turn.started')
        self.assertIn(('turn.phase', 'waiting_model'), summary)
        self.assertIn(('turn.phase', 'validating'), summary)
        self.assertEqual(summary[-1], ('turn.finished', 'completed'))

    def test_candidate_turn_reports_saving_and_candidate_id(self):
        self.send(mode='edit', return_value=LLMResponse('reply', data=EDIT, model_id='test'))
        events = self.events()['events']
        self.assertIn('saving_candidate', [e['payload'].get('phase') for e in events])
        finished = events[-1]['payload']
        self.assertEqual(finished['status'], 'completed')
        self.assertTrue(finished['candidate_id'])

    def test_failed_turn_finishes_with_reason(self):
        self.send(side_effect=RuntimeError('网络暂时不可用'))
        finished = self.events()['events'][-1]
        self.assertEqual(finished['type'], 'turn.finished')
        self.assertEqual(finished['payload']['status'], 'failed')
        self.assertIn('网络', finished['payload']['error_message'])

    def test_cursor_returns_only_newer_events_and_replay_is_idempotent(self):
        self.send(return_value=LLMResponse('第一轮'))
        first = self.events()['events']
        tail = self.events(after=first[-2]['sequence'])['events']
        self.assertEqual([e['sequence'] for e in tail], [first[-1]['sequence']])
        unique, gaps = dedupe_by_sequence(first + tail)
        self.assertEqual((len(unique), gaps), (len(first), []))

    def test_event_store_failure_never_breaks_the_reply(self):
        with patch.object(EventBroker, 'publish', side_effect=OSError('disk full')):
            self.send(return_value=LLMResponse('照常完成'))
        rows = self.service.call('chat.get', {'conversation_id': self.cid})['messages']
        self.assertEqual(rows[-1]['status'], 'completed')
        self.assertEqual(self.events()['events'], [])


if __name__ == '__main__':
    unittest.main()
