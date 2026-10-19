import hashlib
import unittest
from pathlib import Path

from ice_agent.export.bundle import export_bundle,export_markdown_with_images,plain_text_with_images,ExportBlocked
from ice_agent.export.markdown_content import unmanaged_images
from tests import temp_dir


class TestExportContent(unittest.TestCase):
    def test_plain_text_formats_links_lists_tables_without_touching_code(self):
        body='# 标题\n\n**重点**和*强调*，`a_b`；[甲](https://one.example) [乙](https://two.example)。\n\n3. 第三项\n4. 第四项\n\n| 列一 | 列二 |\n| --- | --- |\n| A | B |\n\n```python\nprint("**原样** [链接](path) _x_")\n```\n'
        text=plain_text_with_images(body,{})
        self.assertIn('重点和强调，a_b',text)
        self.assertIn('甲（https://one.example） 乙（https://two.example）',text)
        self.assertIn('3. 第三项',text);self.assertIn('4. 第四项',text)
        self.assertIn('列一\t列二',text);self.assertIn('A\tB',text)
        self.assertIn('print("**原样** [链接](path) _x_")',text)
        self.assertNotIn('# 标题',text);self.assertNotIn('| ---',text)

    def test_only_real_image_nodes_need_archiving_not_fenced_or_inline_examples(self):
        body='![普通图片](images/a.png)\n\n段落中的![小图](https://example.com/img.png)。\n\n![引用图][asset]\n\n[asset]: images/ref.png\n\n<img src="raw.png" alt="HTML图">\n\n```markdown\n![示例](not-real.png)\n```\n\n`![示例](also-not-real.png)`\n\n![图2：已管理](待配图：截图｜Agent)\n'
        images=unmanaged_images(body)
        self.assertEqual([row['caption'] for row in images],['普通图片','小图','引用图','HTML图'])

    def test_image_span_rewrite_preserves_other_bytes_and_long_fences(self):
        body='前文  \n\n![图2：结果](待配图：截图｜Agent)\n\n````markdown\n```\n![图2：演示](待配图：截图｜Agent)\n```\n````\n\n末尾\n'
        exported=export_markdown_with_images(body,{2:'02-02.png'})
        self.assertEqual(exported,body.replace('![图2：结果](待配图：截图｜Agent)','![图2：结果](../图片/02-02.png)'))

    def test_verified_output_is_embedded_and_cannot_break_its_fence(self):
        body='# 稿件\n\n<!--RUN_OUTPUT:run-demo-->\n'
        runs={'run-demo':{'stdout':'真实输出\n```\n保留输出中的围栏\n','stderr':'实际错误\n'}}
        statuses={'run-demo':{'ok':True}}
        md=export_markdown_with_images(body,{},runs=runs,run_refs_status=statuses)
        self.assertIn('````text\n真实输出\n```\n',md);self.assertIn('[stderr]\n实际错误',md)
        self.assertNotIn('RUN_OUTPUT',md)
        txt=plain_text_with_images(body,{},runs=runs,run_refs_status=statuses)
        self.assertIn('真实输出\n```\n保留输出中的围栏',txt);self.assertIn('[stderr]\n实际错误',txt)
        self.assertNotIn('运行输出待解析',txt)

    def test_unverified_output_stays_visible_as_a_draft_problem(self):
        body='# 草稿\n\n<!--RUN_OUTPUT:run-missing-->\n'
        self.assertIn('RUN_OUTPUT',export_markdown_with_images(body,{}))
        self.assertIn('运行输出待解析：run-missing',plain_text_with_images(body,{}))

    def test_ready_rejects_unmanaged_images_but_draft_reports_them(self):
        root=temp_dir('export-content-');body='# 稿件\n\n![未归档](private/local.png)\n'
        common={'job_id':'job-fixture','title':'稿件','body':body,'content_hash':hashlib.sha256(body.encode()).hexdigest(),'figures':[],'runs':{}}
        with self.assertRaises(ExportBlocked):export_bundle(**common,destination=root/'ready',mode='ready',allow_ready=True)
        result=export_bundle(**common,destination=root/'draft',mode='draft')
        self.assertEqual(result['checks']['unmanaged_images'],[{'caption':'未归档'}])
        self.assertFalse((root/'ready').exists())
        self.assertFalse(any('-staging-' in item.name for item in root.iterdir()))

    def test_exported_markdown_checksum_matches_actual_utf8_bytes_on_windows(self):
        root=temp_dir('export-newlines-');body='# 标题\n\n正文\n'
        result=export_bundle(job_id='fixture',title='标题',body=body,content_hash=hashlib.sha256(body.encode()).hexdigest(),figures=[],runs={},destination=root/'bundle')
        raw=(root/'bundle/文本/01-公众号正文.md').read_bytes()
        self.assertEqual(raw,body.encode('utf-8'))
        self.assertEqual(result['body_sha256'],hashlib.sha256(raw).hexdigest())

    def test_changed_run_evidence_expires_delivery_review_even_when_body_is_unchanged(self):
        from ice_agent.automation import delivery_hash
        state={'integrated_md':'<!--RUN_OUTPUT:run-x-->','runs':{'run-x':{'code_sha256':'source','stdin_hash':'input','output_sha256':'old','verdict':'ok','exit_code':0}}}
        before=delivery_hash(state,[])
        state['runs']['run-x']['output_sha256']='new'
        self.assertNotEqual(delivery_hash(state,[]),before)

    def test_bound_literal_output_cannot_be_edited_while_retaining_its_run_anchor(self):
        from ice_agent.export.markdown_content import output_reference_errors
        record={'run_id':'run-bound','stdout':'21\r\n','stderr':'','output_sha256':'a'*64}
        body='```text\n21\n```\n<!--RUN_REF:run-bound|aaaaaaaaaaaa-->\n'
        self.assertEqual(output_reference_errors(body,{'run-bound':record}),[])
        self.assertEqual(output_reference_errors(body.replace('21','42'),{'run-bound':record}),['run-bound'])
        self.assertEqual(output_reference_errors(body,{}),['run-bound'])
        self.assertEqual(output_reference_errors('````markdown\n'+body+'````\n',{}),[])
