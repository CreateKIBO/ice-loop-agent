"""G-only cancellation regression; external network and cloud keys unavailable."""
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
sys.path.insert(0, str(repo))
out = Path(__file__).parent
runtime = repo/'.test-tmp/release-execution'/uuid4().hex[:12]
runtime.mkdir(parents=True)
(runtime/'.test-owner.json').write_text('{"purpose":"execution cancellation regression"}', encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):
    os.environ.pop(key, None)
import tests
tests.TEST_TMP = runtime
suite = unittest.defaultTestLoader.loadTestsFromName('tests.test_execution_cancellation')
with ((out/'execution-cancellation-final.log').open('w', encoding='utf-8') as log,
      patch.object(socket.socket, 'connect', side_effect=RuntimeError('Network disabled'))):
    faulthandler.dump_traceback_later(90, repeat=True, file=log)
    try:
        result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
report = {'state':'finished', 'tests':result.testsRun, 'failures':len(result.failures),
          'errors':len(result.errors), 'skipped':len(result.skipped), 'success':result.wasSuccessful(),
          'runtime':str(runtime), 'network':'disabled; six cloud provider keys removed'}
(out/'execution-cancellation-final.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
sys.exit(0 if result.wasSuccessful() else 1)
