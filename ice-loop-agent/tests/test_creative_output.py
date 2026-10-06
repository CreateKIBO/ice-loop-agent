import json
import unittest

from ice_agent.llm.creative_output import normalize_creative_output
from ice_agent.llm.errors import SchemaInvalidError


class CreativeOutputTests(unittest.TestCase):
    def test_complete_markdown_never_parses_json_inside_code_as_article(self):
        text = '# 完整初稿\n\n开头。\n\n```python\nvalue = {"body":"这是代码中的值"}\n# 代码注释\n```\n\n## 写在最后\n正文最后一段。'
        value, notes = normalize_creative_output(text)
        self.assertEqual(value['body'], text)
        self.assertEqual(value['title'], '完整初稿')
        self.assertTrue(notes)

    def test_markdown_wrapper_and_repeated_h1_are_normalized_outside_code(self):
        text = '```markdown\n# 文章标题\n\n正文。\n\n# 第二部分\n\n```python\n# 注释\n```\n\n结尾。\n```'
        value, _ = normalize_creative_output(text)
        self.assertIn('## 第二部分', value['body'])
        self.assertIn('```python\n# 注释\n```', value['body'])
        self.assertTrue(value['body'].startswith('# 文章标题'))
        self.assertTrue(value['body'].endswith('结尾。'))

    def test_json_body_without_heading_uses_explicit_title(self):
        value, _ = normalize_creative_output(json.dumps({'title': '文章标题', 'body': '正文。\n\n保留结尾。'}))
        self.assertEqual(value['body'], '# 文章标题\n\n正文。\n\n保留结尾。')
        self.assertEqual(value['prompts'], [])

    def test_json_body_starting_section_preserves_section_heading(self):
        value, _ = normalize_creative_output(json.dumps({'title': '总标题', 'body': '## 一、第一部分\n\n正文'}))
        self.assertEqual(value['body'], '# 总标题\n\n## 一、第一部分\n\n正文')

    def test_fenced_json_keeps_backticks_inside_article_and_ignores_suffix(self):
        body = '# 标题\n\n```python\nprint(1)\n```\n\n结尾。'
        payload = json.dumps({'article': {'title': '标题', 'markdown': body}}, ensure_ascii=False)
        value, _ = normalize_creative_output('以下是结果：\n```json\n' + payload + '\n```\n请审阅。')
        self.assertEqual(value['body'], body)

    def test_questions_can_omit_empty_editorial_fields(self):
        value, _ = normalize_creative_output(json.dumps({'questions': [{'id': 'reader', 'question': '读者是谁？', 'options': []}]}))
        self.assertEqual(value['body'], '')
        self.assertEqual(value['title'], '')
        self.assertEqual(value['questions'][0]['id'], 'reader')
        self.assertIn('补充以下信息', value['reply'])

    def test_markdown_h2_title_is_promoted(self):
        value, _ = normalize_creative_output('## 标题\n\n文章正文。\n\n### 第二节\n结尾。')
        self.assertTrue(value['body'].startswith('# 标题\n'))
        self.assertIn('### 第二节', value['body'])

    def test_plain_discussion_and_empty_json_are_not_drafts(self):
        for text in ('我认为可以讨论这个观点。', '{}', '```python\nprint(1)\n```'):
            with self.subTest(text=text), self.assertRaises(SchemaInvalidError):
                normalize_creative_output(text)


if __name__ == '__main__':
    unittest.main()
