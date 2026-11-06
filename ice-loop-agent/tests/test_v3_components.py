"""v3 P2 排版主题与组件：提示卡片、多图并排；clean 主题输出保持不变。"""
from __future__ import annotations

import base64
import io
import unittest
from types import SimpleNamespace

from PIL import Image

from ice_agent.documents.markdown_io import content_to_md
from ice_agent.documents.render import Renderer
from ice_agent.documents.schema import DocumentError, content_hash, image_refs, normalize, plain_text_of
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


def para(text):
    return {'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}


def doc(*blocks, style=None):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': list(blocks)}, 'style': style or {}}


def resolve(attrs):
    return {'mime': 'image/png', 'size': 1, 'width': 10, 'height': 10, 'sha256': attrs['resourceId'], 'file_path': '/x',
            'data_url': lambda preview: 'data:image/png;base64,AA'}


class TestComponents(unittest.TestCase):
    def test_callout_normalize_render_text_markdown(self):
        content = normalize(doc({'type': 'callout', 'attrs': {'tone': 'tip', 'title': '小提示'},
                                 'content': [para('先备份'), {'type': 'heading', 'content': [{'type': 'text', 'text': '不允许'}]}]}))
        block = content['doc']['content'][0]
        self.assertEqual(block['attrs']['tone'], 'tip')
        self.assertEqual([c['type'] for c in block['content']], ['paragraph'])  # 卡片内只留段落/列表
        self.assertEqual(plain_text_of(block), '小提示\n先备份')
        rendered = Renderer(content, resolve_image=resolve).run()
        self.assertIn('background-color:#ecfdf5', rendered['html'])
        self.assertIn('小提示', rendered['html'])
        self.assertIn('【小提示】', rendered['text'])
        self.assertIn('> **小提示**', content_to_md(content))
        bad = normalize(doc({'type': 'callout', 'attrs': {'tone': 'neon'}, 'content': []}))
        self.assertEqual(bad['doc']['content'][0]['attrs']['tone'], 'brand')
        self.assertNotIn('title', bad['doc']['content'][0]['attrs'])
        with self.assertRaises(DocumentError):
            normalize(doc({'type': 'callout', 'attrs': {'title': '长' * 61}}))

    def test_image_group(self):
        group = {'type': 'imageGroup', 'attrs': {'columns': 3, 'caption': '三张对比', 'images': [
            {'resourceId': 'resource-a', 'caption': '前'}, {'resourceId': 'resource-b'}, {'resourceId': 'resource-c', 'caption': '后'}]}}
        content = normalize(doc(para('开头'), group, {'type': 'articleImage', 'attrs': {'resourceId': 'resource-d'}}))
        self.assertEqual([r['resourceId'] for r in image_refs(content)], ['resource-a', 'resource-b', 'resource-c', 'resource-d'])
        rendered = Renderer(content, resolve_image=resolve).run()
        self.assertEqual([i['order'] for i in rendered['images']], [1, 2, 3, 4])
        self.assertEqual(rendered['html'].count('display:inline-block;width:32%'), 3)
        self.assertIn('【图1、图2、图3：三张对比】', rendered['text'])
        self.assertIn('【图4】', rendered['text'])
        self.assertEqual(content_to_md(content).count('resource:'), 4)
        missing = Renderer(content, resolve_image=lambda a: None if a['resourceId'] == 'resource-b' else resolve(a)).run()
        self.assertTrue(any(i['kind'] == 'image_missing' for i in missing['issues']))
        for images in ([{'resourceId': 'resource-a'}], [{'resourceId': 'bad'}, {'resourceId': 'resource-b'}]):
            with self.assertRaises(DocumentError):
                normalize(doc({'type': 'imageGroup', 'attrs': {'images': images}}))

    def test_themes(self):
        base = doc({'type': 'heading', 'attrs': {'level': 2}, 'content': [{'type': 'text', 'text': '小标题'}]},
                   {'type': 'blockquote', 'content': [para('引用')]}, {'type': 'codeBlock', 'content': [{'type': 'text', 'text': 'x'}]})
        clean = normalize(base)
        self.assertEqual(clean['style']['theme'], 'clean')
        outputs = {}
        for theme in ('clean', 'magazine', 'tech', 'warm'):
            content = normalize({**base, 'style': {'theme': theme}})
            outputs[theme] = Renderer(content, resolve_image=resolve).run()['html']
        self.assertEqual(len(set(outputs.values())), 4)
        self.assertIn('text-align:center;border-bottom', outputs['magazine'])
        self.assertIn('background-color:#0f172a', outputs['tech'])
        self.assertIn('border-radius:12px', outputs['warm'])
        with self.assertRaises(DocumentError):
            normalize({**base, 'style': {'theme': 'neon'}})
        self.assertEqual(content_hash(normalize(clean)), content_hash(clean))  # 规范化幂等，旧文章 hash 不变

    def test_bundle_exports_group_images(self):
        root = temp_dir('v3-comp-')
        runtime = root / 'runtime'
        runtime.mkdir()
        store = Store(runtime / 'app.db')
        try:
            docs = DocumentService(SimpleNamespace(runtime=runtime), store, {'id': 'acct-a'})
            ids = []
            for color in ((200, 0, 0), (0, 200, 0)):
                buffer = io.BytesIO()
                Image.new('RGB', (40, 30), color).save(buffer, 'PNG')
                ids.append(docs.image_import_data({'data_url': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()})['resource_id'])
            created = docs.create({'kind': 'blank'})
            saved = docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'], 'content': doc(
                para('正文'), {'type': 'imageGroup', 'attrs': {'images': [{'resourceId': i} for i in ids]}})})
            rendered = docs.render_delivery({'document_id': created['document_id'], 'base_revision': saved['revision']})
            self.assertEqual(len(rendered['images']), 2)
            self.assertEqual(rendered['cover']['source'], 'first_image')
            target = root / 'bundle'
            result = docs.export_bundle({'document_id': created['document_id'], 'version_id': rendered['version_id'], 'destination': str(target)})
            self.assertEqual(result['images'], 2)
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()
