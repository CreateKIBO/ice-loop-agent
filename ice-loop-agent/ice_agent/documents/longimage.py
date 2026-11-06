"""P2 长图与切片、SVG 转图片。

截图在桌面主进程的隐藏窗口里完成（同一套 Chromium 排版，和手机预览一致）；
引擎只负责：生成受限页面、拼接分段截图、在空白行处切片、写入用户授权的新目录。
SVG 只经 <img> 渲染为位图（脚本与外链资源在图片上下文中不会执行/加载），正文里插入的是 PNG。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import html as htmllib
import io
import json
from pathlib import Path
from typing import Any

from .schema import DocumentError

WIDTHS = (375, 414, 750)
MAX_HEIGHT = 60000          # CSS px
MAX_SEGMENTS = 80
CSP = ("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:")


def page_html(rendered_html: str, title: str, author: str, width: int) -> str:
    """长图页面：交付 HTML 原样放进固定宽度的手机版心；不含任何脚本。"""
    if width not in WIDTHS:
        raise DocumentError('长图宽度只支持 375/414/750')
    head = (f'<h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.4;font-weight:bold;color:#111827;">{htmllib.escape(title)}</h1>'
            + (f'<p style="margin:0 0 20px 0;font-size:14px;color:#8a8f99;">{htmllib.escape(author)}</p>' if author else
               '<div style="height:12px"></div>'))
    return ('<!doctype html><html><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'
            f'<meta name="viewport" content="width={width}">'
            '<style>html,body{margin:0;padding:0;background:#ffffff;}'
            'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;}'
            '::-webkit-scrollbar{display:none;}</style></head>'
            f'<body><main style="width:{width}px;box-sizing:border-box;padding:24px 16px 32px 16px;">{head}{rendered_html}</main></body></html>')


def stitch(segments: list[dict], total_height: int, width: int):
    """把按滚动位置截下的分段拼成一张长图；分段可重叠（最后一段对齐底部）。"""
    from PIL import Image
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAX_SEGMENTS:
        raise DocumentError('长图分段数量无效')
    if type(total_height) is not int or not 1 <= total_height <= MAX_HEIGHT:
        raise DocumentError(f'长图高度需在 1–{MAX_HEIGHT} 像素之间（太长请分篇）')
    images = []
    for item in segments:
        if not isinstance(item, dict) or type(item.get('y')) is not int or item['y'] < 0 or not isinstance(item.get('png_base64'), str):
            raise DocumentError('长图分段格式无效')
        try:
            image = Image.open(io.BytesIO(base64.b64decode(item['png_base64'], validate=True)))
            image.load()
        except (binascii.Error, ValueError, OSError):
            raise DocumentError('长图分段不是有效的 PNG') from None
        images.append((item['y'], image.convert('RGB')))
    scale = images[0][1].width / width  # 设备像素比
    if not 0.5 <= scale <= 4:
        raise DocumentError('长图截图尺寸异常')
    canvas = Image.new('RGB', (images[0][1].width, round(total_height * scale)), (255, 255, 255))
    for y, image in images:
        canvas.paste(image, (0, round(y * scale)))
    return canvas, scale


def cut_points(image, slice_px: int, search_px: int) -> list[int]:
    """在每个目标切点上方 search_px 范围内找“最空白”的一行（亮度方差最小，且偏好纯白），避免切断文字或图片。"""
    from PIL import ImageStat
    height = image.height
    points = [0]
    gray = image.convert('L')
    while height - points[-1] > slice_px:
        target = points[-1] + slice_px
        best, best_score = target, None
        for row in range(target, max(points[-1] + slice_px // 2, target - search_px), -2):
            stat = ImageStat.Stat(gray.crop((0, row, gray.width, row + 1)))
            score = stat.var[0] + (255 - stat.mean[0]) * 0.5
            if best_score is None or score < best_score:
                best, best_score = row, score
                if score == 0:
                    break
        points.append(best)
    points.append(height)
    return points


def write_bundle(destination: Path, canvas, scale: float, slice_height: int, meta: dict) -> dict:
    if type(slice_height) is not int or not 400 <= slice_height <= 4000:
        raise DocumentError('切片高度需在 400–4000 像素之间')
    staging = destination.parent / (destination.name + '-staging')
    if destination.exists() or staging.exists():
        raise DocumentError('导出目录已存在；为避免覆盖请重新选择导出位置')
    (staging / '切片').mkdir(parents=True)
    try:
        files = {}
        long_path = staging / '长图.png'
        canvas.save(long_path, 'PNG', optimize=True)
        files['长图.png'] = hashlib.sha256(long_path.read_bytes()).hexdigest()
        points = cut_points(canvas, round(slice_height * scale), round(160 * scale))
        slices = []
        for index, (top, bottom) in enumerate(zip(points, points[1:]), start=1):
            name = f'切片/{index:02d}.png'
            part = canvas.crop((0, top, canvas.width, bottom))
            part.save(staging / name, 'PNG', optimize=True)
            files[name] = hashlib.sha256((staging / name).read_bytes()).hexdigest()
            slices.append({'file': name, 'top': top, 'height': bottom - top})
        manifest = {**meta, 'pixel_width': canvas.width, 'pixel_height': canvas.height, 'device_scale': round(scale, 3),
                    'slice_height_css': slice_height, 'slices': slices, 'files': files,
                    'note': '长图与切片由交付版本渲染，仅供配图/分享使用；不等于已发布。'}
        (staging / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        staging.rename(destination)
    except Exception:
        import shutil
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {'destination': str(destination), 'pixel_width': canvas.width, 'pixel_height': canvas.height,
            'slices': len(slices), 'version_id': meta.get('version_id')}


def check_svg(text: Any) -> str:
    if not isinstance(text, str) or not text.strip() or len(text) > 2_000_000:
        raise DocumentError('SVG 文件需小于 2MB')
    head = text.lstrip()[:2000].lower()
    if '<svg' not in head and not head.startswith('<?xml'):
        raise DocumentError('这不是 SVG 文件')
    return text
