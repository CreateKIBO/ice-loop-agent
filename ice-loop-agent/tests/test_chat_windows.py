import json
import unittest

from ice_agent.creative_chat import CreativeChat
from ice_agent.desktop_service import DesktopService
from tests import REPO, temp_dir


class ChatWindowTests(unittest.TestCase):
    def setUp(self):
        self.service = DesktopService(REPO, temp_dir('chat-window-'), auto_consumer=False)
        self.cid = self.service.call('chat.create')['conversation']['id']
        self.other = self.service.call('chat.create')['conversation']['id']
        self.account = self.service.call('bootstrap')['account']['id']
        _, _, store = self.service._app()
        try:
            for i in range(105):
                for cid in [self.cid, self.other]:
                    store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                        (f'{cid}-{i}', cid, 'assistant', f'第{i}条\n正文', 'completed', '{}', 'same-time'))
            self.candidates = [CreativeChat._insert_candidate(store, self.account, self.cid,
                f'稿{i}', f'# 稿{i}\n正文', {}, [], None) for i in range(8)]
            store.conn.commit()
        finally:
            store.close()

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def get(self, **params):
        return self.service.call('chat.get', {'conversation_id': self.cid, **params})

    def test_legacy_complete_and_bounded_tail_are_independent(self):
        legacy = self.get()
        self.assertEqual(len(legacy['messages']), 105)
        self.assertEqual(len(legacy['candidates']), 8)
        self.assertNotIn('message_page', legacy)
        page = self.get(message_limit=40, candidate_limit=3)
        self.assertEqual([m['content'] for m in page['messages']], [f'第{i}条\n正文' for i in range(65, 105)])
        self.assertEqual(len(page['candidates']), 3)
        self.assertTrue(page['message_page']['has_older'])
        self.assertFalse(page['message_page']['has_newer'])
        self.assertNotIn('window_rowid', json.dumps(page))

    def test_walk_all_history_both_directions_with_equal_dates_and_interleaved_rows(self):
        page = self.get(message_limit=40, candidate_limit=1)
        found = list(page['messages'])
        while page['message_page']['has_older']:
            page = self.get(message_limit=40, candidate_limit=1, before_message_id=page['message_page']['oldest_id'])
            found = page['messages'] + found
        self.assertEqual([r['id'] for r in found], [f'{self.cid}-{i}' for i in range(105)])
        self.assertTrue(page['message_page']['has_newer'])
        found = list(page['messages'])
        while page['message_page']['has_newer']:
            page = self.get(message_limit=40, candidate_limit=1, after_message_id=page['message_page']['newest_id'])
            found += page['messages']
        self.assertEqual(len({m['id'] for m in found}), 105)
        self.assertEqual(len(found), 105)

    def test_candidate_history_walks_without_losing_body_or_hash(self):
        page = self.get(message_limit=1, candidate_limit=3)
        found = page['candidates'][:]
        while page['candidate_page']['has_older']:
            page = self.get(message_limit=1, candidate_limit=3, before_candidate_id=page['candidate_page']['oldest_id'])
            found += page['candidates']
        self.assertEqual([c['id'] for c in found], list(reversed(self.candidates)))
        self.assertTrue(all(c['content_hash'] and c['body'].startswith('# 稿') for c in found))
        newer = self.get(message_limit=1, candidate_limit=3, after_candidate_id=page['candidate_page']['newest_id'])
        self.assertEqual([c['id'] for c in newer['candidates']], list(reversed(self.candidates[2:5])))

    def test_cursor_is_bound_to_conversation_and_kind(self):
        for params in [dict(message_limit=4, before_message_id=self.other + '-20'),
                       dict(message_limit=4, before_message_id=self.candidates[0]),
                       dict(candidate_limit=3, before_candidate_id=self.cid + '-20'),
                       dict(message_limit=4, after_message_id='deleted')]:
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.get(**params)

    def test_reject_invalid_limits_and_directions_without_mutation(self):
        for kind, maximum in [('message', 100), ('candidate', 20)]:
            for invalid in [0, -1, maximum + 1, True, '40', 2.5]:
                with self.subTest(kind=kind, invalid=invalid), self.assertRaises(ValueError):
                    self.get(**{kind + '_limit': invalid})
            with self.assertRaises(ValueError):
                self.get(**{'before_' + kind + '_id': 'x'})
            with self.assertRaises(ValueError):
                self.get(**{kind + '_limit': 2, 'before_' + kind + '_id': 'x', 'after_' + kind + '_id': 'x'})
        self.assertEqual(len(self.get()['messages']), 105)

    def test_later_append_does_not_move_older_window(self):
        first = self.get(message_limit=40, candidate_limit=1)
        cursor = first['message_page']['oldest_id']
        older = self.get(message_limit=40, before_message_id=cursor, candidate_limit=1)
        _, _, store = self.service._app()
        try:
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                ('new-message', self.cid, 'assistant', '新增', 'streaming', '{}', 'same-time'))
            store.conn.commit()
        finally:
            store.close()
        self.assertEqual(older, self.get(message_limit=40, before_message_id=cursor, candidate_limit=1))
        self.assertEqual(self.get(message_limit=40, candidate_limit=1)['messages'][-1]['id'], 'new-message')
