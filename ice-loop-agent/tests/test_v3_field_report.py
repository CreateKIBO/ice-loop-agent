"""v3.21 实测汇总工具：基于数据副本生成报告，原库不变；包含兼容记录、试用记录与性能结果。"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import unittest

from ice_agent.desktop_service import DesktopService
from tests import REPO, temp_dir


class TestFieldReport(unittest.TestCase):
    def test_report_from_copy(self):
        root = temp_dir('v3-field-report-')
        service = DesktopService(REPO, root / 'runtime', root / 'articles')
        try:
            service.call('bootstrap')
            sample = service.call('documents.compat_create', {'themes': ['clean']})['document_ids'][0]
            service.call('documents.compat_record', {'document_id': sample, 'items': {'C01': {'paste': 'pass'}}})
            service.call('documents.trial_start', {'author': '试用者'})
            service.call('documents.create', {'kind': 'blank', 'title': '试用稿'})
        finally:
            service.workers.shutdown(wait=True)
            service.close()
        perf = root / 'perf.json'
        perf.write_text(json.dumps({'head': 'abc', 'timings': {'list_documents': {'median_ms': 4.2}}, 'environment': {'platform': 'Win'},
                                    'sample': {'chars': 10000, 'images': 30}, 'peak_rss_mb': 300}), encoding='utf-8')
        database = root / 'runtime' / 'app.db'
        before = hashlib.sha256(database.read_bytes()).hexdigest()
        out = root / 'report.md'
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join(p for p in (os.environ.get('PYTHONPATH'), str(REPO)) if p)}
        result = subprocess.run([sys.executable, str(REPO / 'tools' / 'field-report.py'), '--runtime', str(root / 'runtime'),
                                 '--perf', str(perf), '--out', str(out)], capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = out.read_text(encoding='utf-8')
        self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before)  # 原库未改
        self.assertRegex(text, r'数据库版本 v\d+')
        self.assertIn('#### 微信兼容记录', text)
        self.assertIn('| C01 | 段落：首行缩进、居中/右对齐 | 保留 |', text)
        self.assertIn('作者试用报告', text)
        self.assertIn('| list_documents | 4.2 |', text)
        self.assertNotIn('正文一段', text)

    def test_missing_database(self):
        root = temp_dir('v3-field-report-missing-')
        result = subprocess.run([sys.executable, str(REPO / 'tools' / 'field-report.py'), '--runtime', str(root)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
