"""英文一段式生图提示词组装器（article-craft 9.3 七要素，确定性实现）。

七段顺序固定：Use case → 画布比例与尺寸 → 配色与参考图 → exactly 图内文字
→ 布局 → flat editorial 风格定调 → 禁止清单。品牌常量嵌入；头像只作参考不重绘。
"""
from __future__ import annotations

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
    exactly = "; ".join(f"exactly “{line}”" for line in exactly_lines if line)
    if reference_note:
        ref = (f" Use the supplied reference image {reference_note} while"
               " preserving the approved identity source without redrawing"
               " the avatar.")
    else:
        ref = ""
    identity = brand.get("name", "publication") if brand else "ICE Loop beginner programming"
    colors = ", ".join(brand.get("colors", [])) if brand else BRAND_COLORS
    style = brand.get("image_style", "flat editorial") if brand else "a restrained flat editorial style for a mature technical publication"
    if brand and brand.get("name") != "ICE Loop" and prohibitions == DEFAULT_PROHIBITIONS:
        prohibitions = "No extra text or unapproved product logos."
    return (
        f"Create an {use_case} for an {identity} article, "
        f"with a {ratio} canvas targeting {size[0]} by {size[1]} pixels. "
        f"Use {colors}.{ref} "
        f"Show {exactly}. "
        f"{layout} "
        f"Use {style}. "
        f"{prohibitions}"
    )


def cover_prompt(series: str, title_lines: list[str], episode_tag: str,
                 template_note: str, *, brand: dict | None = None) -> str:
    """封面提示词：套栏目封面模板，只换标题与编号（AGENTS.md §2.5）。"""
    ratio = "2.35:1"
    size = (1880, 800)
    return compose_prompt(
        use_case="ads-marketing cover",
        ratio=ratio,
        size=size,
        exactly_lines=[*title_lines, episode_tag],
        layout=(
            "Keep the title left aligned, generous margins, and the brand area "
            "on the right, following the supplied cover template composition."
        ),
        reference_note=f"({template_note}) as the composition reference" if template_note else "",
        brand=brand,
    )


def body_diagram_prompt(caption: str, exactly_lines: list[str],
                        layout: str, *, brand: dict | None = None) -> str:
    """正文图示提示词：4:3，手机可读。"""
    return compose_prompt(
        use_case="infographic-diagram illustration",
        ratio="4:3",
        size=(1200, 900),
        exactly_lines=exactly_lines or [caption],
        brand=brand,
        layout=layout or (
            "Arrange the reading order top to bottom with clear arrows and "
            "generous whitespace."),
    )
