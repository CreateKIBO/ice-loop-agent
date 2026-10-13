"""Offline focused reacceptance, with unique test IDs and G-only owned fixtures."""
import json
import os
import sys
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

repo = Path(__file__).resolve().parents[2]
out = Path(__file__).parent
runtime = repo / '.test-tmp/reaccept-beta1-20261008'
runtime.mkdir(parents=True, exist_ok=True)
(runtime / '.test-owner.json').write_text(json.dumps({'purpose': 'beta1 scoped acceptance'}), encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
os.environ['PYTHONUTF8'] = '1'
for key in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'BIGMODEL_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY'):
    os.environ.pop(key, None)
sys.path.insert(0, str(repo))
import tests
tests.TEST_TMP = runtime

def flatten(suite):
    for case in suite:
        if isinstance(case, unittest.TestSuite):
            yield from flatten(case)
        else:
            yield case

if '--collect' in sys.argv:
    counts = Counter(case.id() for case in flatten(unittest.defaultTestLoader.discover(str(repo/'tests'), top_level_dir=str(repo))))
    report = {'listed': sum(counts.values()), 'unique': len(counts), 'duplicates': {k:v for k,v in counts.items() if v>1}, 'executed': False}
    (out/'collection.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
    sys.exit(0)
modules = ['tests.test_review_small_fixes', 'tests.test_v2_export_trusted', 'tests.test_v2_batches23',
           'tests.test_v2_queue_consumer', 'tests.test_v2_migrations', 'tests.test_model_budgets']
if '--final' in sys.argv:
    modules += ['tests.test_beta1_reaccept']
stem = 'final' if '--final' in sys.argv else 'baseline'
suite = unittest.TestSuite(flatten(unittest.defaultTestLoader.loadTestsFromNames(modules)))
with patch('socket.socket.connect', side_effect=RuntimeError('offline: no network authorized')), \
     patch('urllib.request.OpenerDirector.open', side_effect=RuntimeError('offline: no network authorized')), \
     (out/(stem+'-tests.log')).open('w', encoding='utf-8') as log:
    result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
report = {'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'skipped':len(result.skipped), 'successful':result.wasSuccessful(), 'modules':modules}
(out/(stem+'-tests.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
sys.exit(0 if result.wasSuccessful() else 1)
