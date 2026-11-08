"""v3.12 微信兼容测试：一键生成覆盖全部可交付元素的测试稿，并逐项记录真实微信结果。

开发报告 §9/§10：真实微信粘贴后、后台保存后、真实手机预览分开记录；未执行写“未验”，
不能用一个“兼容”结论代替。测试稿只用程序生成的色块测试图，不含个人资料。
记录只存在测试稿自己的 meta.compat 中，不影响其他文章。
"""
from __future__ import annotations

import io
import json
import re
from typing import Any

from ..domain.types import now_iso
from .schema import DocumentError, THEMES, block_id

STAGES = (('paste', '粘贴后'), ('saved', '后台保存后'), ('phone', '手机预览'))
RESULTS = {'untested': '未验', 'pass': '保留', 'partial': '部分保留', 'fail': '丢失/错乱'}
ITEMS: list[tuple[str, str]] = [
    ('C01', '段落：首行缩进、居中/右对齐'),
    ('C02', '标题：一级/二级/三级'),
    ('C03', '加粗、斜体、下划线、删除线'),
    ('C04', '文字颜色'),
    ('C05', '文字字号'),
    ('C06', '高亮（背景色）'),
    ('C07', '超链接'),
    ('C08', '无序/有序列表'),
    ('C09', '引用'),
    ('C10', '代码块与行内代码'),
    ('C11', '分隔线'),
    ('C12', '普通图片（顺序与清晰度）'),
    ('C13', '图注'),
    ('C14', '多图并排：2 列'),
    ('C15', '多图并排：3 列'),
    ('C16', '提示卡片（四种颜色）'),
    ('C17', '主题小标题样式'),
    ('C18', '字间距、行距、段距'),
]
THEME_LABEL = {'clean': '简洁', 'magazine': '杂志', 'tech': '科技', 'warm': '温暖'}
PALETTE = [(37, 99, 235), (220, 38, 38), (22, 163, 74), (217, 119, 6), (124, 58, 237), (8, 145, 178), (219, 39, 119)]


def _text(value: str, *marks: dict) -> dict:
    node: dict = {'type': 'text', 'text': value}
    if marks:
        node['marks'] = list(marks)
    return node


def _p(*inline: dict, **attrs: Any) -> dict:
    return {'type': 'paragraph', 'attrs': {'id': block_id(), **attrs}, 'content': list(inline)}


def _label(code: str, title: str) -> dict:
    """每组元素前的小标签，便于在后台/手机上对照记录表。"""
    return _p(_text(f'【{code}】{title}', {'type': 'textStyle', 'attrs': {'color': '#8a8f99', 'fontSize': '13px'}}))


def _test_image(index: int, width: int = 960, height: int = 540) -> bytes:
    """程序生成的色块测试图：大号序号条纹 + 边框，便于肉眼核对顺序与裁切（不依赖字体）。"""
    from PIL import Image, ImageDraw
    color = PALETTE[(index - 1) % len(PALETTE)]
    image = Image.new('RGB', (width, height), (250, 250, 250))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width - 1, height - 1), outline=color, width=12)
    # 用 index 条竖条表示序号（1–9），任何字体环境都能看出顺序。
    bar = width // 24
    for n in range(index):
        x = 60 + n * bar * 2
        draw.rectangle((x, 80, x + bar, height - 80), fill=color)
    draw.rectangle((width - 220, height - 120, width - 60, height - 60), fill=(17, 24, 39))
    buffer = io.BytesIO()
    image.save(buffer, 'PNG', optimize=True)
    return buffer.getvalue()


def sample_content(theme: str, images: list[str]) -> dict:
    """测试稿内容。images 为 9 张已入库的测试图资源 id。"""
    if theme not in THEMES:
        raise DocumentError('主题无效')
    bold, italic = {'type': 'bold'}, {'type': 'italic'}
    underline, strike = {'type': 'underline'}, {'type': 'strike'}
    code = {'type': 'code'}

    def color(c: str) -> dict:
        return {'type': 'textStyle', 'attrs': {'color': c}}

    def size(s: str) -> dict:
        return {'type': 'textStyle', 'attrs': {'fontSize': s}}

    def highlight(c: str) -> dict:
        return {'type': 'textStyle', 'attrs': {'backgroundColor': c}}

    link = {'type': 'link', 'attrs': {'href': 'https://example.com/compat-test'}}
    blocks = [
        _p(_text(f'这是一篇微信兼容测试稿（主题：{THEME_LABEL[theme]}）。请复制到公众号后台，分别在“粘贴后”“后台保存后”“手机预览”三个阶段，'
                 '对照每组前的【编号】在应用里记录结果。测试稿只含程序生成的测试图，不含个人资料。')),
        _label('C01', '段落'),
        _p(_text('这一段设置了首行缩进两个字。微信后台常见的问题是缩进被去掉，或者整段被套上额外的样式。'), indent=True),
        _p(_text('这一段居中对齐。'), textAlign='center'),
        _p(_text('这一段右对齐。'), textAlign='right'),
        _label('C02', '标题'),
        {'type': 'heading', 'attrs': {'id': block_id(), 'level': 1}, 'content': [_text('一级标题：测试')]},
        {'type': 'heading', 'attrs': {'id': block_id(), 'level': 2}, 'content': [_text('二级标题：测试')]},
        {'type': 'heading', 'attrs': {'id': block_id(), 'level': 3}, 'content': [_text('三级标题：测试')]},
        _label('C03', '文字样式'),
        _p(_text('加粗', bold), _text('、'), _text('斜体', italic), _text('、'), _text('下划线', underline), _text('、'),
           _text('删除线', strike), _text('、'), _text('加粗斜体', bold, italic), _text('。')),
        _label('C04', '文字颜色'),
        _p(_text('红色', color('#dc2626')), _text(' / '), _text('绿色', color('#16a34a')), _text(' / '),
           _text('蓝色', color('#2563eb')), _text(' / '), _text('紫色', color('#7c3aed'))),
        _label('C05', '文字字号'),
        _p(_text('12px', size('12px')), _text(' · '), _text('15px', size('15px')), _text(' · '), _text('20px', size('20px')),
           _text(' · '), _text('24px', size('24px'))),
        _label('C06', '高亮'),
        _p(_text('黄色高亮', highlight('#fff3a3')), _text(' 和 '), _text('绿色高亮', highlight('#dcfce7')), _text(' 和 '),
           _text('红字加蓝底', {'type': 'textStyle', 'attrs': {'color': '#dc2626', 'backgroundColor': '#dbeafe'}})),
        _label('C07', '超链接'),
        _p(_text('这是一个'), _text('测试链接', link), _text('（公众号正文通常只保留公众号文章链接，外链可能变为纯文字）。')),
        _label('C08', '列表'),
        {'type': 'bulletList', 'attrs': {'id': block_id()}, 'content': [
            {'type': 'listItem', 'content': [_p(_text('无序列表第一项'))]},
            {'type': 'listItem', 'content': [_p(_text('无序列表第二项'))]}]},
        {'type': 'orderedList', 'attrs': {'id': block_id(), 'start': 1}, 'content': [
            {'type': 'listItem', 'content': [_p(_text('有序列表第一项'))]},
            {'type': 'listItem', 'content': [_p(_text('有序列表第二项'))]}]},
        _label('C09', '引用'),
        {'type': 'blockquote', 'attrs': {'id': block_id()}, 'content': [_p(_text('这是一段引用，检查左边线、底色和字色。'))]},
        _label('C10', '代码'),
        _p(_text('行内代码：'), _text('print("hello")', code)),
        {'type': 'codeBlock', 'attrs': {'id': block_id(), 'language': 'python'},
         'content': [_text('def hello():\n    # 缩进与换行应保留\n    return "你好"')]},
        _label('C11', '分隔线'),
        {'type': 'horizontalRule', 'attrs': {'id': block_id()}},
        _label('C12', '普通图片（应为 1 条竖条）'),
        {'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': images[0], 'caption': '', 'width': 100, 'align': 'center'}},
        _label('C13', '图注（应为 2 条竖条，下方有图注）'),
        {'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': images[1], 'caption': '图注：两条竖条',
                                           'width': 80, 'align': 'center'}},
        _label('C14', '多图 2 列（3、4 条竖条）'),
        {'type': 'imageGroup', 'attrs': {'id': block_id(), 'columns': 2, 'caption': '两列并排',
                                         'images': [{'resourceId': images[2], 'caption': '左'}, {'resourceId': images[3], 'caption': '右'}]}},
        _label('C15', '多图 3 列（5、6、7 条竖条）'),
        {'type': 'imageGroup', 'attrs': {'id': block_id(), 'columns': 3, 'caption': '三列并排', 'images': [
            {'resourceId': images[4], 'caption': ''}, {'resourceId': images[5], 'caption': ''}, {'resourceId': images[6], 'caption': ''}]}},
        _label('C16', '提示卡片'),
    ]
    for tone, title in (('brand', '品牌色卡片'), ('info', '说明卡片'), ('tip', '提示卡片'), ('warn', '注意卡片')):
        blocks.append({'type': 'callout', 'attrs': {'id': block_id(), 'tone': tone, 'title': title},
                       'content': [_p(_text(f'{title}的正文，检查底色、左边线和圆角。'))]})
    blocks += [
        _label('C17', f'主题小标题（{THEME_LABEL[theme]}）'),
        {'type': 'heading', 'attrs': {'id': block_id(), 'level': 2}, 'content': [_text('主题二级标题样式')]},
        {'type': 'heading', 'attrs': {'id': block_id(), 'level': 3}, 'content': [_text('主题三级标题样式')]},
        _label('C18', '字间距、行距、段距'),
        _p(_text('本测试稿设置了 1px 字间距、2 倍行距、20px 段距。连续几段用来对比间距：')),
        _p(_text('第二段：间距对比。')),
        _p(_text('第三段：间距对比。最后一张测试图（8 条竖条）用来确认图片总数与顺序。')),
        {'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': images[7], 'caption': '最后一张', 'width': 100, 'align': 'center'}},
    ]
    return {'schema': 1, 'doc': {'type': 'doc', 'content': blocks},
            'style': {'theme': theme, 'letterSpacing': 1, 'lineHeight': 2.0, 'paragraphSpacing': 20},
            'info': {'author': '兼容测试', 'summary': '微信兼容测试稿：逐项记录粘贴后、后台保存后与手机预览的结果。',
                     'coverResourceId': images[8]}}


def _empty_record() -> dict:
    return {code: {stage: 'untested' for stage, _ in STAGES} | {'note': ''} for code, _ in ITEMS}


class CompatTesting:
    def __init__(self, docs_service: Any):
        self.service = docs_service
        self.docs = docs_service.docs
        self.store = docs_service.store

    def create(self, params: dict) -> dict:
        themes = params.get('themes') or ['clean']
        if not isinstance(themes, list) or not themes or len(themes) > len(THEMES) or any(t not in THEMES for t in themes):
            raise DocumentError('请选择要测试的主题')
        themes = list(dict.fromkeys(themes))
        images = [self.service.import_image_bytes(_test_image(i), f'兼容测试图{i}',
                                                  {'kind': 'file', 'original_name': f'compat-test-{i}.png'})['resource_id']
                  for i in range(1, 10)]
        stamp = now_iso()[:10]
        created = []
        for theme in themes:
            document = self.docs.create(title=f'微信兼容测试稿·{THEME_LABEL[theme]}（{stamp}）', content=sample_content(theme, images),
                                        origin='blank', series='兼容测试',
                                        meta={'source_label': '兼容测试稿', 'compat_sample': {'theme': theme, 'created_at': now_iso()},
                                              'compat': {'items': _empty_record(), 'environment': {}, 'updated_at': None}},
                                        note='兼容测试稿')
            created.append(document['document_id'])
        return {'document_ids': created, 'items': len(ITEMS)}

    def _sample(self, document_id: str) -> dict:
        document = self.docs._row(document_id)
        if not document['meta'].get('compat_sample'):
            raise DocumentError('这篇不是兼容测试稿')
        return document

    def get(self, params: dict) -> dict:
        document = self._sample(self.service._id(params))
        compat = document['meta'].get('compat') or {}
        items = _empty_record() | (compat.get('items') or {})
        return {'document_id': document['document_id'], 'theme': document['meta']['compat_sample']['theme'],
                'items': [{'code': code, 'label': label, **items[code]} for code, label in ITEMS],
                'stages': [{'key': key, 'label': label} for key, label in STAGES],
                'results': RESULTS, 'environment': compat.get('environment') or {}, 'updated_at': compat.get('updated_at')}

    def record(self, params: dict) -> dict:
        document_id = self.service._id(params)
        document = self._sample(document_id)
        updates = params.get('items') or {}
        if not isinstance(updates, dict):
            raise DocumentError('记录格式无效')
        compat = document['meta'].get('compat') or {}
        items = _empty_record() | (compat.get('items') or {})
        for code, value in updates.items():
            if code not in items or not isinstance(value, dict):
                raise DocumentError('记录里有未知的测试项')
            for stage, _ in STAGES:
                if stage in value:
                    if value[stage] not in RESULTS:
                        raise DocumentError('结果只能是：未验、保留、部分保留、丢失/错乱')
                    items[code][stage] = value[stage]
            if 'note' in value:
                note = value['note']
                if not isinstance(note, str) or len(note) > 300:
                    raise DocumentError('每项说明最多 300 字')
                items[code]['note'] = note.strip()
        environment = compat.get('environment') or {}
        if 'environment' in params:
            env = params['environment']
            if not isinstance(env, dict):
                raise DocumentError('环境信息格式无效')
            for key in ('os', 'scale', 'wechat', 'phone', 'head'):
                if key in env:
                    value = env[key]
                    if not isinstance(value, str) or len(value) > 120:
                        raise DocumentError('环境信息每项最多 120 字')
                    environment[key] = value.strip()
        meta = dict(document['meta'])
        meta['compat'] = {'items': items, 'environment': environment, 'updated_at': now_iso()}
        with self.store.transaction():
            self.store.conn.execute('UPDATE documents SET meta_json=? WHERE document_id=?',
                                    (json.dumps(meta, ensure_ascii=False), document_id))
        return self.get({'document_id': document_id})

    def report(self, params: dict) -> dict:
        """Markdown 记录表，可直接粘进验收记录（与本地验收清单的模板一致）。"""
        data = self.get(params)
        env = data['environment']
        document = self.docs._row(data['document_id'])
        lines = [f'# 微信兼容记录：{document["title"]}', '',
                 f'- 源码 HEAD：{env.get("head") or "（未填）"}',
                 f'- 系统 / 缩放：{env.get("os") or "（未填）"} / {env.get("scale") or "（未填）"}',
                 f'- 微信后台 / 手机：{env.get("wechat") or "（未填）"} / {env.get("phone") or "（未填）"}',
                 f'- 主题：{THEME_LABEL.get(data["theme"], data["theme"])}；记录时间：{data["updated_at"] or "（未记录）"}', '',
                 '| 编号 | 测试项 | 粘贴后 | 后台保存后 | 手机预览 | 说明 |', '|---|---|---|---|---|---|']
        counts = {key: 0 for key in RESULTS}
        for item in data['items']:
            cells = [RESULTS[item[stage]] for stage, _ in STAGES]
            for stage, _ in STAGES:
                counts[item[stage]] += 1
            note = re.sub(r'\s+', ' ', re.sub(r'[|\n]+', ' ', item['note'])).strip()
            lines.append(f'| {item["code"]} | {item["label"]} | ' + ' | '.join(cells) + f' | {note} |')
        total = len(data['items']) * len(STAGES)
        lines += ['', '统计：' + '，'.join(f'{RESULTS[k]} {v}' for k, v in counts.items()) + f'（共 {total} 格）。',
                  '“未验”表示没有执行，不能计为兼容。']
        return {'markdown': '\n'.join(lines) + '\n', 'counts': counts, 'total': total}
