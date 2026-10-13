"""本轮隔离验收入口：不改产品，测试临时目录限定本轮G盘owner目录。"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
runtime = repo / '.test-tmp' / 'review-20261008'
runtime.mkdir(parents=True, exist_ok=True)
(runtime / '.review-owner.json').write_text(json.dumps({'purpose': 'GLM upgrade acceptance', 'date': '2026-10-08'}), encoding='utf-8')
sys.path.insert(0, str(repo))
os.environ['PYTHONUTF8'] = '1'
for key in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'BIGMODEL_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY'):
    os.environ.pop(key, None)
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
import tests
tests.TEST_TMP = runtime

legacy_safety = '--safety' in sys.argv
if '--collect' in sys.argv:
    from collections import Counter
    collected = unittest.defaultTestLoader.discover(str(repo / 'tests'), top_level_dir=str(repo))
    def flatten(value):
        if isinstance(value, unittest.TestSuite):
            for child in value:
                yield from flatten(child)
        else:
            yield value.id()
    counts = Counter(flatten(collected))
    summary = {'listed': sum(counts.values()), 'unique_ids': len(counts), 'duplicate_ids': {key: number for key, number in counts.items() if number > 1}, 'discovery_errors': [key for key in counts if '_FailedTest' in key], 'tests_executed': False}
    (runtime / 'test-discovery.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))
    sys.exit(0)
modules = ['tests.test_runner', 'tests.test_execution_review', 'tests.test_model_budgets'] if legacy_safety else sorted('tests.' + path.stem for path in (repo / 'tests').glob('test_v2*.py'))
output_stem = 'python-safety' if legacy_safety else 'python-v2'
suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
with (runtime / (output_stem + '-tests.log')).open('w', encoding='utf-8') as output:
    result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
summary = {'modules': modules, 'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped), 'successful': result.wasSuccessful(), 'failure_ids': [case.id() for case, _ in result.failures], 'error_ids': [case.id() for case, _ in result.errors]}
(runtime / (output_stem + '-result.json')).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
sys.exit(0 if result.wasSuccessful() else 1)
