"""C3：预算面板数据——会话已用/剩余、0 表示显式不限制、未配置按默认 24。离线。"""
import unittest

from ice_agent.desktop_service import DesktopService
from ice_agent.model_budgets import DEFAULT_CHAT_CALLS, chat_budget
from tests import REPO, temp_dir


class BudgetPanelTests(unittest.TestCase):
    def setUp(self):
        self.service = DesktopService(REPO, temp_dir('budget-panel-') / 'runtime')
        self.cid = self.service.call('chat.create', {})['conversation']['id']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def test_unconfigured_chat_budget_uses_default_not_zero(self):
        self.service.settings.pop('max_chat_calls', None)
        view = self.service.call('budgets.get', {'conversation_id': self.cid})
        self.assertEqual(view['max_chat_calls'], DEFAULT_CHAT_CALLS)
        self.assertFalse(view['chat_configured'])
        self.assertFalse(view['chat_unlimited'])
        self.assertEqual(view['conversation']['used'], 0)
        self.assertEqual(view['conversation']['remaining'], DEFAULT_CHAT_CALLS)

    def test_zero_means_unlimited_and_save_persists(self):
        saved = self.service.call('budgets.save', {
            'scope': 'defaults', 'max_model_calls': self.service.settings['max_model_calls'],
            'max_image_model_calls': self.service.settings.get('max_image_model_calls', 12),
            'max_chat_calls': 0})
        self.assertTrue(saved['chat_unlimited'])
        self.assertTrue(saved['chat_configured'])
        reloaded = self.service.call('budgets.get', {'conversation_id': self.cid})
        self.assertEqual(reloaded['conversation']['remaining'], None)
        self.assertEqual(reloaded['conversation']['limit'], 0)

    def test_other_account_conversation_is_refused(self):
        self.service.settings['active_account_id'] = 'other-account'
        with self.assertRaisesRegex(ValueError, '公众号'):
            self.service.call('budgets.get', {'conversation_id': self.cid})

    def test_chat_budget_rejects_bad_values(self):
        for value in (-1, 1001, True, '24'):
            with self.assertRaises(ValueError):
                chat_budget({'max_chat_calls': value})


if __name__ == '__main__':
    unittest.main()
