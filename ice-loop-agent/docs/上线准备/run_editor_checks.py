"""G-only editor regression runner. All network is blocked."""
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
runtime = repo/'.test-tmp/release-editor-tests'/uuid4().hex[:12]
runtime.mkdir(parents=True)
(runtime/'.test-owner.json').write_text('{"purpose":"editor regression"}',encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):
    os.environ.pop(key,None)
import tests
tests.TEST_TMP = runtime
modules = ['tests.test_editor_recovery']
if '--related' in sys.argv: modules.append('tests.test_v2_editor')
suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
report_path = out/'editor-tests.json'
report_path.write_text(json.dumps({'state':'running','tests':suite.countTestCases()}),encoding='utf-8')
with ((out/'editor-tests.log').open('w',encoding='utf-8') as log,
      patch.object(socket.socket,'connect',side_effect=RuntimeError('Network disabled'))):
    faulthandler.dump_traceback_later(120,repeat=True,file=log)
    try: result = unittest.TextTestRunner(stream=log,verbosity=2).run(suite)
    finally: faulthandler.cancel_dump_traceback_later()
report = {'state':'finished','tests':result.testsRun,'failures':len(result.failures),
          'errors':len(result.errors),'skipped':len(result.skipped),'success':result.wasSuccessful(),'runtime':str(runtime)}
report_path.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
sys.exit(0 if result.wasSuccessful() else 1)
