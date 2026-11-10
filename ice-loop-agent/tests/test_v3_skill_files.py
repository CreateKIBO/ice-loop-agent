"""v3.19 技能参考资料与示例：保存、引用、版本、按阶段进入提示词、ZIP 导入导出。"""
from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from ice_agent.desktop_service import DesktopService
from ice_agent.documents.assist import DocumentAssist
from ice_agent.prompts import render
from ice_agent.skill_packages import parse
from ice_agent.skills import materials_text, skill_for_prompt
from tests import REPO, temp_dir


class TestSkillFiles(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-skill-files-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service.call('bootstrap')['account']

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def call(self, method, **params):
        return self.service.call(method, {'account_id': self.account['id'], **params})

    def add_files(self):
        return self.call('skills.files_add', files=[
            {'name': '风格指南.md', 'kind': 'reference', 'text': '短句为主，少用形容词。'},
            {'name': '范文一.md', 'kind': 'example', 'text': '那天下午，我第一次把旧书柜清空。'}])['files']

    def attach(self, files):
        state = self.call('skills.get')
        ice = next(s for s in state['skills'] if s['id'] == 'ice-writing')
        ice['files'] = files
        return self.service.call('skills.save', state)

    def profile(self):
        _, cfg, store = self.service._app()
        try:
            return cfg.profile
        finally:
            store.close()

    def test_add_attach_and_version(self):
        files = self.add_files()
        self.assertEqual([f['stages'] for f in files], [['plan', 'write', 'review'], ['write']])
        again = self.add_files()  # 同名同内容复用
        self.assertEqual([f['id'] for f in again], [f['id'] for f in files])
        state = self.attach(files)
        ice = next(s for s in state['skills'] if s['id'] == 'ice-writing')
        self.assertEqual(ice['version'], 2)  # 加了参考文件算一次修改
        self.assertEqual(self.call('skills.file_get', file_id=files[1]['id'])['text'], '那天下午，我第一次把旧书柜清空。')
        self.assertEqual(self.call('skills.version', skill_id='ice-writing', version=2)['files'][0]['name'], '风格指南.md')
        self.assertEqual(self.call('skills.version', skill_id='ice-writing', version=1)['files'], [])
        # 只改阶段也算修改
        state['skills'][[s['id'] for s in state['skills']].index('ice-writing')]['files'][1]['stages'] = ['write', 'review']
        self.assertEqual(next(s for s in self.service.call('skills.save', state)['skills'] if s['id'] == 'ice-writing')['version'], 3)

    def test_validation(self):
        for bad in ([{'name': 'x', 'text': ''}], [{'name': 'x', 'text': '字' * 20001}], [{'name': 'x', 'kind': 'script', 'text': 'a'}], []):
            with self.assertRaises(ValueError):
                self.call('skills.files_add', files=bad)
        state = self.call('skills.get')
        state['skills'][0]['files'] = [{'id': 'file-missing', 'name': 'a', 'kind': 'reference', 'stages': ['write']}]
        with self.assertRaisesRegex(ValueError, '不存在'):
            self.service.call('skills.save', state)
        state['skills'][0]['files'] = [{'id': 'file-x', 'name': 'a', 'kind': 'reference', 'stages': []}]
        with self.assertRaises(ValueError):
            self.service.call('skills.save', state)
        with self.assertRaises(ValueError):
            self.service.call('skills.file_get', {'account_id': 'someone-else', 'file_id': 'file-x'})

    def test_materials_reach_prompts_by_stage(self):
        self.attach(self.add_files())
        snapshot = self.profile()['writing_skill_snapshot']
        self.assertEqual([m['name'] for m in snapshot['materials']], ['风格指南.md', '范文一.md'])
        self.assertNotIn('materials', skill_for_prompt(snapshot))
        outline = render('outline', profile=self.profile())
        draft = render('draft', profile=self.profile())
        self.assertIn('短句为主', outline)
        self.assertNotIn('旧书柜', outline)  # 示例默认只用于写作阶段
        self.assertIn('旧书柜', draft)
        self.assertIn('不照抄', draft)
        self.assertEqual(materials_text(snapshot, 'review').count('【'), 1)
        context = DocumentAssist.profile_context(self.profile(), 'rewrite')
        self.assertIn('旧书柜', context['skill_materials'])
        self.assertNotIn('旧书柜', json.dumps(context['writing_skill'], ensure_ascii=False))  # 参考正文不重复塞进技能
        self.assertNotIn('旧书柜', DocumentAssist.profile_context(self.profile(), 'image_slots').get('skill_materials', ''))

    def test_no_files_keeps_snapshot_unchanged(self):
        snapshot = self.profile()['writing_skill_snapshot']
        self.assertNotIn('materials', snapshot)
        self.assertEqual(materials_text(snapshot, 'write'), '')

    def test_zip_export_round_trip(self):
        self.attach(self.add_files())
        exported = self.call('skills.export', skill_id='ice-writing')
        self.assertTrue(exported['file_name'].endswith('.zip'))
        raw = base64.b64decode(exported['data_base64'])
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = set(archive.namelist())
            manifest = json.loads(archive.read('skill.json'))
        self.assertEqual(names, {'SKILL.md', 'skill.json', 'references/风格指南.md', 'examples/范文一.md'})
        self.assertEqual([f['kind'] for f in manifest['files']], ['reference', 'example'])
        parsed = parse({'data_base64': exported['data_base64'], 'file_name': exported['file_name']})
        self.assertEqual([(f['name'], f['kind'], f['stages']) for f in parsed['files']],
                         [('范文一.md', 'example', ['write']), ('风格指南.md', 'reference', ['plan', 'write', 'review'])])
        self.assertEqual(parsed['ignored_files'], [])
        markdown = self.call('skills.export', skill_id='general-writing')
        self.assertIn('markdown', markdown)  # 没有参考文件的技能仍导出 Markdown

    def test_zip_import_limits(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('SKILL.md', '# 方法\n正文')
            archive.writestr('references/big.md', '字' * 20001)
            archive.writestr('references/pic.png', b'\x89PNG')
            archive.writestr('samples/one.txt', '示例文字')
        result = parse({'data_base64': base64.b64encode(buffer.getvalue()).decode(), 'file_name': 'p.zip'})
        self.assertEqual([(f['name'], f['kind']) for f in result['files']], [('one.txt', 'example')])
        self.assertEqual(result['ignored_files'], ['references/big.md', 'references/pic.png'])
        self.assertTrue(any('超过' in w for w in result['warnings']))


if __name__ == '__main__':
    unittest.main()
