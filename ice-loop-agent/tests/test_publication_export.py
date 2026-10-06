"""Publishing material, external-edit protection, and restored-directory contracts."""
import shutil
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
from ice_agent.export.publication import destination, export_publication, rewrite_images
from ice_agent.export.exporter import ExportConflict
from tests import temp_dir


class TestPublicationExport(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('publication-export-')
        self.archive = self.root / 'articles' / '001-中文标题'
        (self.archive / 'images').mkdir(parents=True)
        Image.new('RGB', (100, 60), '#2448db').save(self.archive / 'images' / 'figure-01.png')
        self.ctx = SimpleNamespace(cfg=SimpleNamespace(runtime_root=self.root / 'runtime'), state={'abstract': '发布摘要'})
        self.target, self.manifest = destination(self.ctx, self.archive.parent, self.archive.name)
        self.body = '# 中文标题\n\n![图1：封面](images/figure-01.png)\n\n```python\nprint("](" + "images/figure-01.png)")\n![图1：代码里的文本](images/figure-01.png)\n```\n'

    def export(self, figures=None):
        return export_publication(self.ctx, self.archive, self.target, self.manifest, self.body,
                                  {'1': 'images/figure-01.png'} if figures is None else figures,
                                  '中文标题', 'PY', 11, 'assets_pending')

    def test_two_folders_valid_links_no_code_html_metadata(self):
        result = self.export()
        self.assertEqual({p.name for p in self.target.iterdir()}, {'文本', '图片'})
        self.assertEqual(result['publishing_layout'], ['文本', '图片'])
        text = self.target / '文本' / '01-公众号正文.md'
        body = text.read_text(encoding='utf-8')
        self.assertIn('![图1：封面](../图片/figure-01.png)', body)
        self.assertIn('![图1：代码里的文本](images/figure-01.png)', body)
        self.assertIn('print("](" + "images/figure-01.png)")', body)
        self.assertTrue((text.parent / '../图片/figure-01.png').is_file())
        self.assertIn('草稿', (text.parent / '02-发布信息.txt').read_text(encoding='utf-8'))
        self.assertEqual([p.suffix for p in (self.target / '图片').iterdir()], ['.png'])
        self.assertFalse(any(p.suffix in {'.html', '.py', '.json'} for p in self.target.rglob('*')))

    def test_reexport_removes_old_unselected_images(self):
        self.export()
        self.export({})
        self.assertEqual(list((self.target / '图片').iterdir()), [])
        self.assertIn('(images/figure-01.png)', (self.target / '文本/01-公众号正文.md').read_text(encoding='utf-8'))
        self.assertEqual(list(self.target.parent.glob('.publishing-*')), [])

    def test_external_edit_rejected_without_loss(self):
        self.export()
        path = self.target / '文本/01-公众号正文.md'
        path.write_text('用户修改', encoding='utf-8')
        with self.assertRaises(ExportConflict):
            self.export()
        self.assertEqual(path.read_text(encoding='utf-8'), '用户修改')

    def test_untracked_folder_not_overwritten(self):
        self.target.mkdir(parents=True)
        path = self.target / '保留.txt'
        path.write_text('原文件', encoding='utf-8')
        with self.assertRaises(ExportConflict):
            self.export()
        self.assertEqual(path.read_text(encoding='utf-8'), '原文件')

    def test_restore_to_different_root_reexport(self):
        self.export()
        restored = self.root / 'restored'
        shutil.copytree(self.archive.parent, restored)
        target, manifest = destination(self.ctx, restored, self.archive.name)
        export_publication(self.ctx, restored / self.archive.name, target, manifest,
                           self.body, {1: 'images/figure-01.png'}, '中文标题', 'PY', 11, 'assets_pending')
        self.assertTrue((target / '图片/figure-01.png').is_file())

    def test_image_looking_text_in_tilde_and_long_backtick_code_unchanged(self):
        original = '~~~~text\n![图](images/a.png)\n~~~~\n````md\n```\n![图](images/a.png)\n````\n![图](images/a.png)\n'
        result = rewrite_images(original, {'images/a.png': '../图片/a.png'})
        self.assertEqual(result.count('(images/a.png)'), 2)
        self.assertEqual(result.count('(../图片/a.png)'), 1)
