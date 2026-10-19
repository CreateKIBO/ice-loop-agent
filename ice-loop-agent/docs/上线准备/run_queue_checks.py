"""Deterministic queue release regression runner. G-only, external IO blocked."""
import faulthandler
import json
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(repo))
out = Path(__file__).parent
runtime = repo/'.test-tmp/release-queue'/uuid4().hex[:12]
runtime.mkdir(parents=True)
(runtime/'.test-owner.json').write_text('{"purpose":"queue reliability regression"}',encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):
    os.environ.pop(key,None)
import tests
tests.TEST_TMP = runtime
modules = ['tests.test_queue_reliability']
if '--related' in sys.argv:
    modules += ['tests.test_v2_queue_consumer','tests.test_v2_task_queue','tests.test_v2_cancel_idempotency',
                'tests.test_release_runtime','tests.test_task_lifecycle','tests.test_workflow',
                'tests.test_agent_task_safety','tests.test_v2_agent']
if '--agent-only' in sys.argv: modules = ['tests.test_agent_task_safety']
if '--fence-only' in sys.argv: modules = [
    'tests.test_queue_reliability.TestConsumerStateSafety.test_corrupt_cross_account_binding_never_pauses_another_accounts_job',
    'tests.test_release_runtime.TestWaitingReconciliation']
suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
stem = 'agent-task-tests' if '--agent-only' in sys.argv else 'queue-related-tests' if '--related' in sys.argv else 'queue-tests'
if '--fence-only' in sys.argv: stem = 'queue-fence-tests'
report_path = out/(stem+'.json')
report_path.write_text(json.dumps({'state':'running','tests':suite.countTestCases(),'runtime':str(runtime)}),encoding='utf-8')
with ((out/(stem+'.log')).open('w',encoding='utf-8') as log,
      patch.object(socket.socket,'connect',side_effect=RuntimeError('Network disabled'))):
    class WatchedResult(unittest.TextTestResult):
        def startTest(self,test):
            faulthandler.dump_traceback_later(120,repeat=True,file=log)
            super().startTest(test)
        def stopTest(self,test):
            faulthandler.cancel_dump_traceback_later()
            super().stopTest(test)
            report_path.write_text(json.dumps({'state':'running','executed':self.testsRun,
                'failures':len(self.failures),'errors':len(self.errors),'last':test.id()}),encoding='utf-8')
    result = unittest.TextTestRunner(stream=log,verbosity=2,resultclass=WatchedResult).run(suite)
report = {'state':'finished','tests':result.testsRun,'failures':len(result.failures),
          'errors':len(result.errors),'skipped':len(result.skipped),'success':result.wasSuccessful(),'runtime':str(runtime)}
report_path.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
sys.exit(0 if result.wasSuccessful() else 1)
