"""代码围栏感知的 Markdown 解析（§3.2：Markdown 应解析为 AST，
避免在代码块与引用中误识别标题和禁词）。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_CN_NUM = "一二三四五六七八九十"

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_PLACEHOLDER_RE = re.compile(
    r"^!\[图(\d+)：(.+?)\]\(待配图：(.+?)｜(.+?)\)\s*$")
_CODE_FENCE_RE = re.compile(r"^```")


@dataclass
class Block:
    kind: str            # heading / paragraph / code / image / blank
    level: int = 0       # heading 层级 1-6
    text: str = ""       # 标题文本（heading）或段落原文
    lines: list[str] = field(default_factory=list)
    lang: str = ""       # 代码块语言
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ArticleAST:
    blocks: list[Block]
    raw: str

    # ---------------------------------------------------------- 查询
    def headings(self, min_level: int = 1, max_level: int = 6) -> list[Block]:
        return [b for b in self.blocks
                if b.kind == "heading" and min_level <= b.level <= max_level]

    def h1(self) -> Block | None:
        for b in self.blocks:
            if b.kind == "heading" and b.level == 1:
                return b
        return None

    def h2_sections(self) -> list[Block]:
        return self.headings(2, 2)

    def code_blocks(self) -> list[Block]:
        return [b for b in self.blocks if b.kind == "code"]

    def image_placeholders(self) -> list[Block]:
        return [b for b in self.blocks if b.kind == "image"]

    def paragraphs(self) -> list[Block]:
        return [b for b in self.blocks if b.kind == "paragraph"]

    def body_text(self) -> str:
        """正文可见文本（不含标题标记、代码块、图片占位符）。"""
        parts = [b.text for b in self.blocks if b.kind in ("paragraph", "heading")]
        return "\n".join(parts)

    def code_and_fence_text(self) -> str:
        """代码块内容（禁词扫描需排除，代码里出现什么都合法）。"""
        return "\n".join("\n".join(b.lines) for b in self.code_blocks())

    def visible_chars(self) -> int:
        """可见 Unicode 字符计数（去 Markdown 标记；§3.3 长度口径）。"""
        text = self.body_text()
        text = re.sub(r"[*_`>#|]", "", text)
        return len(re.sub(r"\s", "", text))


def parse_markdown(text: str) -> ArticleAST:
    blocks: list[Block] = []
    fence_open = False
    code_lines: list[str] = []
    code_lang = ""
    para_lines: list[str] = []

    def flush_para() -> None:
        nonlocal para_lines
        if para_lines:
            joined = "\n".join(para_lines).strip()
            ph = _PLACEHOLDER_RE.match(joined)
            if ph:
                blocks.append(Block(
                    kind="image", text=joined,
                    meta={"figure_no": int(ph.group(1)), "caption": ph.group(2),
                          "obtain_type": ph.group(3), "obtain_way": ph.group(4)}))
            else:
                blocks.append(Block(kind="paragraph", text=joined, lines=list(para_lines)))
            para_lines = []

    for raw_line in text.splitlines():
        line = raw_line.rstrip("\n")
        if fence_open:
            if _CODE_FENCE_RE.match(line):
                blocks.append(Block(kind="code", lang=code_lang, lines=code_lines))
                fence_open = False
                code_lines = []
                code_lang = ""
            else:
                code_lines.append(line)
            continue
        if _CODE_FENCE_RE.match(line):
            flush_para()
            fence_open = True
            code_lang = line.lstrip("`").strip()
            continue
        if not line.strip():
            flush_para()
            blocks.append(Block(kind="blank", text=""))
            continue
        m = _HEADING_RE.match(line)
        if m:
            flush_para()
            blocks.append(Block(kind="heading", level=len(m.group(1)), text=m.group(2)))
            continue
        para_lines.append(line)
    if fence_open and code_lines:
        blocks.append(Block(kind="code", lang=code_lang, lines=code_lines))
    flush_para()
    return ArticleAST(blocks=blocks, raw=text)


def cn_ordinal(index: int) -> str:
    """1→一 2→二 … 10→十（章节编号校验用）。"""
    if 1 <= index <= 10:
        return _CN_NUM[index - 1]
    if index < 20:
        return "十" + (_CN_NUM[index - 11] if index > 11 else "")
    raise ValueError(f"章节超过十个，编号写法需要人工确认：{index}")


def code_comment_lines(block: Block) -> int:
    """代码块内注释行数（# 或 // 开头；仅统计整行注释）。"""
    n = 0
    for ln in block.lines:
        s = ln.strip()
        if s.startswith("#") or s.startswith("//") or s.startswith("*"):
            n += 1
    return n
