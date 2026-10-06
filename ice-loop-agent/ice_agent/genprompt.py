"""英文一段式生图提示词组装器（article-craft 9.3 七要素，确定性实现）。

七段顺序固定：Use case → 画布比例与尺寸 → 配色与参考图 → exactly 图内文字
→ 布局 → flat editorial 风格定调 → 禁止清单。品牌常量嵌入；头像只作参考不重绘。
"""
from __future__ import annotations
import json
import re

ICE_FILES = {
    'avatar.png': '01-头像-信号蓝.png', 'wordmark.png': '02-横向字标-透明底.png',
    'cover-py.png': '03-封面-Python-001.png', 'cover-jv.png': '04-封面-Java-001.png',
    'cover-ai.png': '05-封面-AI-001.png', 'cover-wk.png': '06-封面-工具周刊-001.png',
    'overview.png': '07-品牌视觉总览.png',
}


def is_ice(brand: dict | None) -> bool:
    return brand is None or brand.get('preset', 'ice-loop' if brand.get('name')=='ICE Loop' else 'general')=='ice-loop'


def reference_inputs(brand: dict | None, series: str = '', kind: str = 'cover') -> list[dict]:
    """Assign each upload a role; do not mix different column cover templates."""
    references = (brand or {}).get('visual_references', [])
    def known(key):
        row = next((r for r in references if r.get('preset_asset') == key), None)
        if row is None and is_ice(brand) and key in ICE_FILES:
            row = {'title': ICE_FILES[key], 'preset_asset': key, 'resource_id': ''}
        return row
    rows = []
    if is_ice(brand):
        template = known('cover-' + series.lower() + '.png') if kind == 'cover' else None
        if template: rows.append(('template', template))
        if identity := known('avatar.png'): rows.append(('identity', identity))
        if kind != 'cover' and (overview := known('overview.png')): rows.append(('style', overview))
        if kind != 'cover':
            extras=[r for r in references if not r.get('preset_asset') and r.get('usage')=='reference']
            rows.extend(('style',r) for r in extras[:2])
    else:
        covers = [r for r in references if r.get('usage') == 'cover']
        matching = [r for r in covers if series and series.casefold() in str(r.get('title', '')).casefold().split()]
        if kind == 'cover' and (matching or covers): rows.append(('template', (matching or covers)[0]))
        others = [r for r in references if r.get('usage') == 'reference' and all(r is not row for _, row in rows)]
        rows.extend(('style', r) for r in others[:2])
    return [{'image': index, 'role': role, 'title': row.get('title', ''),
             'resource_id': row.get('resource_id', ''), 'preset_asset': row.get('preset_asset', ''),
             'filename': ICE_FILES.get(row.get('preset_asset'), row.get('title', '')),
             'description': str(row.get('description', ''))[:300]}
            for index, (role, row) in enumerate(rows, 1)]


def reference_instruction(rows: list[dict], *, cover: bool = False) -> str:
    parts = []
    for row in rows:
        name = json.dumps(row['filename'] or row['title'], ensure_ascii=False)
        if row['role'] == 'template':
            parts.append(f"Image {row['image']} ({name}) is the existing cover to edit, the sole composition source.")
        elif row['role'] == 'identity':
            parts.append(f"Image {row['image']} ({name}) is the USER-APPROVED brand avatar, the sole identity source. "
                         + ("Keep the approved two-line ICE / LOOP mark and its intertwined double-O crossover exactly unchanged." if cover else
                            "Use it for palette and visual identity reference only; do not reproduce a large logo or redraw the avatar."))
        else:
            parts.append(f"Image {row['image']} ({name}) is a visual style reference only; do not copy its example text, "
                         "layout panels, watermarks or unrelated illustrations.")
    return ' '.join(parts)

BRAND_COLORS = "signal blue #2448DB, ink black #15191F and warm white #F3F2ED"

DEFAULT_PROHIBITIONS = (
    "No extra text, real product logos, robots, cartoon characters, ice cubes, "
    "snowflakes, glowing circuits, complex code backgrounds, 3D, gradients, "
    "shadows or device mockups."
)


def compose_prompt(
    *,
    use_case: str,
    ratio: str,
    size: tuple[int, int],
    exactly_lines: list[str],
    layout: str,
    reference_note: str = "",
    prohibitions: str = DEFAULT_PROHIBITIONS,
    brand: dict | None = None,
) -> str:
    """按七要素顺序组装一段英文提示词；exactly 文字逐字列出。"""
    exactly = "; ".join(f"exactly {json.dumps(line,ensure_ascii=False)}" for line in dict.fromkeys(exactly_lines) if line)
    if reference_note:
        ref = (f" Use the supplied reference image {reference_note} while"
               " preserving the approved identity source without redrawing"
               " the avatar.")
    else:
        ref = ""
    identity = brand.get("name", "publication") if brand else "ICE Loop beginner programming"
    colors = ", ".join(brand.get("colors", [])) if brand else BRAND_COLORS
    style = brand.get("image_style", "flat editorial") if brand else "a restrained flat editorial style for a mature technical publication"
    if not is_ice(brand) and prohibitions == DEFAULT_PROHIBITIONS:
        prohibitions = "No extra text or unapproved product logos."
    lettering = f"Show {exactly}. " if exactly else "No in-image text. "
    brief=(brand or {}).get('visual_brief','')
    style_note=f"Publication visual requirements (quoted design context): {json.dumps(brief,ensure_ascii=False)}. " if brief else ''
    refs=reference_instruction(reference_inputs(brand,kind='body_diagram'))
    return (
        f"Use case: {use_case}. Create one legible editorial image for an {identity} article, "
        f"with a {ratio} canvas targeting {size[0]} by {size[1]} pixels, designed for mobile reading. "
        f"Use {colors}.{ref} {refs} "
        f"{lettering}"
        f"{layout} "
        f"Use {style}. "
        f"{prohibitions} "
        f"{style_note}"
    )


def cover_prompt(series: str, title_lines: list[str], episode_tag: str,
                 template_note: str, *, brand: dict | None = None) -> str:
    """封面提示词：套栏目封面模板，只换标题与编号（AGENTS.md §2.5）。"""
    rows=reference_inputs(brand,series,'cover')
    template=next((r for r in rows if r['role']=='template'),None)
    if not template and not is_ice(brand):
        return compose_prompt(use_case='editorial article cover',ratio='2.35:1',size=(1880,800),
            exactly_lines=[*title_lines,episode_tag],brand=brand,
            reference_note=f"({template_note}) as the composition reference" if template_note else '',
            layout='Left-aligned headline in at most two lines; preserve supplied identity assets unchanged. Do not invent a logo.')
    title=' and '.join(json.dumps(line,ensure_ascii=False) for line in title_lines if line)
    target=f"image {template['image']}" if template else 'the supplied existing column cover'
    return (f"Edit {target}, the existing {(brand or {}).get('name','ICE Loop')} article cover. "
        f"{reference_instruction(rows,cover=True)} "
        f"Replace only the existing cover headline with exactly {title}, in the same headline block, "
        "font style, alignment and position, using at most two natural lines. "
        f"Replace only the issue-number portion of the existing series label with exactly {json.dumps(episode_tag,ensure_ascii=False)}; "
        "preserve the English series subtitle and all other label text. "
        "Keep the original landscape aspect ratio, canvas size, margins, title area, brand area, background color, "
        "plain-text brand signature, footer symbols and every other element unchanged. "
        "Preserve the approved identity artwork exactly; never typeset a replacement wordmark, redraw its letter geometry, "
        "recolor the mark or combine stacked and horizontal logo variants. "
        "Mature restrained editorial execution. No new illustrations, no additional logo, no extra text, "
        "no layout redesign, no cropping, no mockup, no 3D, gradients or shadows. Flat graphic.")


def body_diagram_prompt(caption: str, exactly_lines: list[str],
                        layout: str, *, brand: dict | None = None) -> str:
    """正文图示提示词：4:3，手机可读。"""
    return compose_prompt(
        use_case="infographic-diagram illustration",
        ratio="4:3",
        size=(1200, 900),
        exactly_lines=[caption,*exactly_lines,(brand or {}).get('name','ICE Loop')],
        brand=brand,
        layout=('Warm-white #F3F2ED background, ink-black #15191F text, signal-blue #2448DB accents. ' if is_ice(brand) else '')+f"Title exactly {json.dumps(caption,ensure_ascii=False)}. "+(layout or (
            "Arrange the reading order top to bottom with clear arrows and "
            "generous whitespace."))+f" Tiny bottom plain-text signature exactly {json.dumps((brand or {}).get('name','ICE Loop'),ensure_ascii=False)}; do not invent a decorative brand icon.",
    )


def prompt_contract(brand: dict, series: str, episode: int, title: str) -> dict:
    return {'version':2,'cover_inputs':reference_inputs(brand,series,'cover'),
        'diagram_inputs':reference_inputs(brand,series,'body_diagram'),
        'cover_example':cover_prompt(series,[title or '本期标题'],f'{series} / {episode:03d}','',brand=brand),
        'diagram_example':body_diagram_prompt('用嘴编程，怎么协作',
            ['你说需求','把想法讲清楚','AI 写代码','实现交给它','你验证','跑起来，改到位','不满意，重新说'],
            'Three horizontal stages from left to right: speech bubble, simple code rectangle, verification shape. '
            'Connect stages with thin arrows. A return arrow runs from the final stage back to the first, labelled only '
            '"不满意，重新说". Headings above supporting labels; distinguish forward and return directions.',brand=brand),
        'rules':'Examples demonstrate prompt structure only: replace their subject and text with the current article. '
                'Cover: edit matching template only, never introduce a new illustration. Body: specify elements, '
                'positions, relationships, arrow directions and exact short text. No fabricated screenshots. '
                'Upload references in the listed order; text-only prompts cannot attach images automatically.'}


def protect_generated_cover(prompts: list[str], title: str, series: str, episode: int, brand: dict) -> list[str]:
    """Guard newly generated covers only; never rewrite user-saved prompts or diagrams."""
    result=list(prompts)
    if result and series and is_ice(brand) and re.search(r'\bcover\b|封面',result[0],re.IGNORECASE):
        result[0]=cover_prompt(series,[title],f'{series} / {episode:03d}','',brand=brand)
    return result
