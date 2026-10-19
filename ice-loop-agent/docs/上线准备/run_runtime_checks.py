"""G-only, offline runtime regression suite. No cloud requests allowed."""
import json
import os
import sys
import unittest
import faulthandler
from pathlib import Path
from unittest.mock import patch

repo = Path(__file__).resolve().parents[2]
out = Path(__file__).parent
sys.path.insert(0, str(repo))
runtime = repo/'.test-tmp/release-runtime-20261015'
runtime.mkdir(parents=True, exist_ok=True)
runtime.joinpath('.test-owner.json').write_text('{"purpose":"release runtime regressions"}',encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):
    os.environ.pop(key,None)
import tests
tests.TEST_TMP = runtime
modules = ['tests.test_release_runtime']
if '--related' in sys.argv:
    modules += ['tests.test_v2_queue_consumer', 'tests.test_task_lifecycle']
suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
stem = 'baseline-runtime' if '--baseline' in sys.argv else 'runtime-final'
(out/(stem+'.json')).write_text(json.dumps({'state':'running','modules':modules}),encoding='utf-8')
with (patch('socket.socket.connect',side_effect=RuntimeError('offline test: no network')),
      (out/(stem+'.log')).open('w',encoding='utf-8') as log):
    faulthandler.dump_traceback_later(180, repeat=True, file=log)
    try:
        result = unittest.TextTestRunner(stream=log,verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
report = {'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'success':result.wasSuccessful(),'modules':modules}
(out/(stem+'.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
sys.exit(0 if result.wasSuccessful() else 1)
