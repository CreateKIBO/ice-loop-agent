"""Real consumer/engine stop regression, with the same owned browser-fixture gate."""
import tempfile
import time
import unittest

from pathlib import Path
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.tasks import worker
from ice_agent.workflow.nodes import NODE_FUNCS
from tests import REPO
from tests.reading_lifecycle_cancel import CancelProbe


class TestReadingConsumerStop(unittest.TestCase):
    def test_stop_running_engine_before_original_node_returns(self):
        parent = REPO / '.test-tmp/release-interaction-lists'
        parent.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix='consumer-stop-', dir=parent))
        (root / '.test-owner.json').write_text('{"purpose":"bounded consumer stop"}')
        runtime = root / 'runtime'
        # Restore test-only global wrappers, even on assertion failure. Keep the
        # fixture directory for investigation; no shared seed is reused.
        with patch.object(worker, '_run_claimed', worker._run_claimed), patch.dict(NODE_FUNCS):
            probe = CancelProbe(REPO, runtime)
            service = DesktopService(REPO, runtime, root / 'articles', auto_consumer=True)
            try:
                task = probe.call(service, 'test.consumer.enqueue', {'account_id': 'ice-loop'})
                self.assertEqual((task['state'], task['attempt']), ('queued', 0))

                def snapshot_when(predicate):
                    deadline = time.monotonic() + 12
                    while time.monotonic() < deadline:
                        snapshot = probe.call(service, 'test.consumer.snapshot', {})
                        if predicate(snapshot):
                            return snapshot
                        time.sleep(0.05)
                    self.fail(f'Consumer did not reach bounded state: {snapshot}')

                running = snapshot_when(lambda s: s['node'] is not None)
                self.assertEqual(running['task']['state'], 'running')
                self.assertEqual(running['job']['state'], 'running')
                self.assertTrue(running['task']['lease_token'])
                self.assertTrue(running['job']['lease'])
                self.assertEqual(running['events'][0]['thread'], 'ice-queue-consumer')
                result = service.call('jobs.stop', {'account_id': 'ice-loop', 'job_id': running['job_id']})
                self.assertEqual(result, {'state': 'paused', 'stopping': True})
                held = probe.call(service, 'test.consumer.snapshot', {})
                self.assertEqual(held['job']['state'], 'paused')
                self.assertEqual(held['task']['state'], 'running')
                self.assertNotIn('finished', held['node'])
                probe.call(service, 'test.consumer.release', {})
                final = snapshot_when(lambda s: s['task']['state'] == 'paused' and s['events'][0].get('finished'))
                self.assertEqual(final['job_id'], running['job_id'])
                self.assertEqual(final['job']['state'], 'paused')
                self.assertFalse(final['job']['lease'])
                self.assertIsNone(final['task']['lease_token'])
                self.assertEqual(final['task']['attempt'], 1)
                self.assertEqual(len(final['events']), 1)
                self.assertEqual(final['events'][0]['outcome']['status'], 'paused')
                self.assertGreaterEqual(final['node']['finished'], final['node']['released'])
                self.assertIsNone(final['approval'])
            finally:
                probe.release.set()
                service.close()


if __name__ == '__main__':
    unittest.main()
