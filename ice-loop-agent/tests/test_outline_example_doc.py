# -*- coding: utf-8 -*-
"""随库选题大纲示例文档必须能被真实解析器完整解析（批次D-19，2026-10-20）。

docs/栏目选题大纲-示例.md 是用户可复制导入的示例；本测试用
ice_agent.editorial_topics.parse_text（与「选题与排期」导入相同的解析器）
验证：无解析错误、栏目/期号/字段正确、没有把说明行当题目。
同时验证应用内置 example() 生成的示例同样干净。
"""
import unittest
from pathlib import Path

from ice_agent.editorial_topics import example, parse_text

ACCOUNT = {
    'name': '我的公众号',
    'columns': [
        {'code': 'PY', 'name': 'Python 从 0 到 1'},
        {'code': 'JV', 'name': 'Java 打怪升级'},
    ],
}


class OutlineExampleDocTest(unittest.TestCase):
    def test_shipped_example_doc_parses_cleanly(self):
        doc = Path(__file__).resolve().parents[1] / 'docs' / '栏目选题大纲-示例.md'
        self.assertTrue(doc.is_file(), '示例文档应随库提交')
        result = parse_text(doc.read_text(encoding='utf-8'), ACCOUNT)
        self.assertEqual(result['errors'], [], f"示例文档不应有解析错误：{result['errors']}")
        rows = {(row['series'], row['episode']): row for row in result['rows']}
        # 段落式写法（PY 栏）。
        self.assertIn(('PY', 11), rows)
        self.assertEqual(rows[('PY', 11)]['title'], '把已有知识做成一个小作品')
        self.assertEqual(rows[('PY', 11)]['content_angle'], '回顾循环、列表与函数，完成一个可运行项目。')
        self.assertEqual(rows[('PY', 12)]['core_benefit'], '识别输入错误并给出清楚的提示。')
        self.assertEqual(rows[('PY', 100)]['next_episode_plan'], '')
        # 表格写法（JV 栏）：列别名映射到同一字段集。
        self.assertIn(('JV', 11), rows)
        self.assertEqual(rows[('JV', 12)]['title'], '让输入校验给出清楚的反馈')
        self.assertEqual(rows[('JV', 12)]['core_benefit'], '能处理常见错误输入')
        # 两种写法共 5 条题目，没有把文档标题/表头/分隔线当成题目。
        self.assertEqual(len(result['rows']), 5)

    def test_builtin_example_also_parses_cleanly(self):
        result = parse_text(example(ACCOUNT), ACCOUNT)
        self.assertEqual(result['errors'], [])
        series = {row['series'] for row in result['rows']}
        self.assertEqual(series, {'PY', 'JV'})


if __name__ == '__main__':
    unittest.main()
