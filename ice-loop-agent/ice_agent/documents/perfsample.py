"""v3.12 长文多图性能固定样本（开发报告 §9“性能固定样本”与 §10 第 3 项）。

约 1 万字中文正文 + 30 张测试图片；内容与图片由固定种子确定性生成，每张图登记文件大小、像素尺寸与格式。
同一参数生成的正文完全一致；图片像素一致，编码后的字节（sha256）在相同 Pillow/编码库版本下一致，登记表记录了每张图的实际大小与 hash 以便对照。
"""
from __future__ import annotations

import hashlib
import io
import random
from typing import Any

from .schema import DocumentError, block_id

DEFAULT_CHARS, DEFAULT_IMAGES = 10_000, 30
PHRASES = [
    '把复杂的问题拆成几个可以验证的小步骤', '先写下自己真正想解决的问题', '这一步最容易被忽略', '我们换一个角度再看',
    '实际操作时，最好先备份原始文件', '结果和预期不一致时，先检查输入', '这也是很多读者在留言里问到的', '下面用一个例子说明',
    '真正耗时的往往不是写代码，而是确认需求', '记录每一次改动的原因', '不要一次改太多地方', '可以把常用的步骤整理成清单',
    '如果条件允许，请在两台设备上分别试一次', '数字本身不重要，重要的是趋势', '这里的取舍取决于你的读者', '先完成，再完善',
]
# 尺寸与格式轮换：覆盖截图（PNG）、照片（JPEG）、超宽/超高与小图。
SHAPES = [(1080, 720, 'JPEG'), (1920, 1080, 'JPEG'), (750, 1334, 'PNG'), (3000, 2000, 'JPEG'), (640, 480, 'PNG'),
          (1242, 2688, 'JPEG'), (2400, 800, 'PNG'), (1200, 1200, 'JPEG'), (800, 600, 'PNG'), (4000, 3000, 'JPEG')]


def _paragraph(rng: random.Random, target: int) -> str:
    parts: list[str] = []
    while sum(len(p) for p in parts) < target:
        parts.append(rng.choice(PHRASES) + rng.choice('，。；'))
    text = ''.join(parts)
    return text[:-1] + '。'


def make_image(index: int, seed: int) -> tuple[bytes, dict]:
    """确定性测试图：渐变底 + 噪点（让 JPEG/PNG 体积接近真实图片）+ 序号条。"""
    from PIL import Image, ImageDraw
    width, height, fmt = SHAPES[(index - 1) % len(SHAPES)]
    rng = random.Random(seed * 1000 + index)
    base = Image.linear_gradient('L').resize((width, height))
    tint = (rng.randrange(40, 220), rng.randrange(40, 220), rng.randrange(40, 220))
    image = Image.merge('RGB', [base.point(lambda v, c=c: (v * c) // 255) for c in tint])
    small = (max(1, width // 4), max(1, height // 4))
    # 噪点用固定种子的字节生成（PIL 的 effect_noise 依赖全局随机数，不可复现）。
    noise = Image.frombytes('L', small, rng.randbytes(small[0] * small[1])).resize((width, height)).convert('RGB')
    image = Image.blend(image, noise, 0.25)
    draw = ImageDraw.Draw(image)
    bar = max(8, width // 60)
    for n in range(index % 10 or 10):
        draw.rectangle((40 + n * bar * 2, 40, 40 + n * bar * 2 + bar, min(height - 40, 40 + height // 3)), fill=(255, 255, 255))
    buffer = io.BytesIO()
    if fmt == 'JPEG':
        image.save(buffer, 'JPEG', quality=88)
    else:
        image.save(buffer, 'PNG')
    data = buffer.getvalue()
    return data, {'index': index, 'width': width, 'height': height, 'format': fmt.lower(), 'bytes': len(data),
                  'sha256': hashlib.sha256(data).hexdigest()}


def build(docs_service: Any, *, chars: int = DEFAULT_CHARS, images: int = DEFAULT_IMAGES, seed: int = 1,
          title: str | None = None) -> dict:
    """在当前公众号里生成样本文章；返回文章与图片登记表。"""
    if type(chars) is not int or not 1000 <= chars <= 50_000:
        raise DocumentError('正文字数需在 1000–50000 之间')
    if type(images) is not int or not 0 <= images <= 60:
        raise DocumentError('图片数需在 0–60 之间')
    if type(seed) is not int or not 0 <= seed <= 10_000:
        raise DocumentError('种子需在 0–10000 之间')
    rng = random.Random(seed)
    registry = []
    resources = []
    for index in range(1, images + 1):
        data, info = make_image(index, seed)
        resource = docs_service.import_image_bytes(data, f'性能样本图{index:02d}', {'kind': 'file', 'original_name': f'perf-{seed}-{index:02d}.{info["format"]}'})
        info['resource_id'] = resource['resource_id']
        registry.append(info)
        resources.append(resource['resource_id'])
    blocks: list[dict] = []
    written = 0
    per_image = chars // (images + 1) if images else chars
    next_image = 0
    section = 1
    while written < chars:
        if written // 1000 >= section:
            blocks.append({'type': 'heading', 'attrs': {'id': block_id(), 'level': 2},
                           'content': [{'type': 'text', 'text': f'第{section}部分：样本小标题'}]})
            section += 1
        text = _paragraph(rng, rng.randrange(120, 260))
        blocks.append({'type': 'paragraph', 'attrs': {'id': block_id()}, 'content': [{'type': 'text', 'text': text}]})
        written += len(text)
        if next_image < images and written >= per_image * (next_image + 1):
            blocks.append({'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': resources[next_image],
                                                             'caption': f'样本图 {next_image + 1}', 'width': 100, 'align': 'center'}})
            next_image += 1
    while next_image < images:
        blocks.append({'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': resources[next_image],
                                                         'caption': f'样本图 {next_image + 1}', 'width': 100, 'align': 'center'}})
        next_image += 1
    content = {'schema': 1, 'doc': {'type': 'doc', 'content': blocks}, 'style': {}}
    total_bytes = sum(item['bytes'] for item in registry)
    document = docs_service.docs.create(
        title=title or f'性能样本：{chars} 字 / {images} 图（种子 {seed}）', content=content, origin='blank', series='性能样本',
        meta={'source_label': '性能样本', 'perf_sample': {'chars': written, 'images': images, 'seed': seed, 'image_bytes': total_bytes,
                                                         'registry': registry}},
        note='性能固定样本')
    return {'document_id': document['document_id'], 'chars': written, 'images': images, 'seed': seed,
            'image_bytes': total_bytes, 'registry': registry}
