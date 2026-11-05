"""结构规则：标题层级、编号、开头段、结尾三件套、代码块与字数（§2.2 / §3.1）。

规则分三级：
- block：阻断，就绪导出前必须修复；
- warn：需人工判断（如注释行数偏语义）；
- info：提示。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .markdown_ast import ArticleAST, Block, cn_ordinal, code_comment_lines

_H3_NUM_RE = re.compile(r"^(\d+)[.、]\s*(.+)$")
_H4_NUM_RE = re.compile(r"^[①②③④⑤⑥⑦⑧⑨⑩]\s*(.+)$")

_OUTPUT_LANGS = ("text", "output", "输出")


def executable_code_blocks(ast: ArticleAST) -> list[Block]:
    """演示代码块（不含 ```text 运行输出块）。"""
    return [b for b in ast.code_blocks() if b.lang.lower() not in _OUTPUT_LANGS]


@dataclass
class Finding:
    rule: str
    level: str          # block / warn / info
    message: str
    excerpt: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"rule": self.rule, "level": self.level,
                "message": self.message, "excerpt": self.excerpt}


@dataclass
class RuleReport:
    findings: list[Finding] = field(default_factory=list)

    def add(self, rule: str, level: str, message: str, excerpt: str = "") -> None:
        self.findings.append(Finding(rule, level, message, excerpt))

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "block"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "warn"]

    @property
    def passed(self) -> bool:
        return not self.blocking

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "blocking": [f.to_dict() for f in self.blocking],
            "warnings": [f.to_dict() for f in self.warnings],
            "info": [f.to_dict() for f in self.findings if f.level == "info"],
        }


def check_structure(ast: ArticleAST, profile: dict[str, Any],
                    target_words: tuple[int, int] | None = None) -> RuleReport:
    """文章结构检查；profile 为 ice-loop 规则 JSON 的顶层 dict。"""
    rpt = RuleReport()
    rules: dict[str, Any] = profile["article"]
    ending = rules["required_ending_heading"]
    triad: dict[str, str] = rules["ending_triad"]

    # ---- H1 唯一 ---------------------------------------------------
    h1s = [b for b in ast.blocks if b.kind == "heading" and b.level == 1]
    if not h1s:
        rpt.add("h1.unique", "block", "缺少一级标题（# 标题）")
    elif len(h1s) > 1:
        rpt.add("h1.unique", "block", f"一级标题出现 {len(h1s)} 次，全文只能有一个")

    # ---- 开头段不许有小标题 -----------------------------------------
    first_h2_idx = next((i for i, b in enumerate(ast.blocks)
                         if b.kind == "heading" and b.level == 2), None)
    if first_h2_idx is None and rules.get('require_sections', True):
        rpt.add("h2.exists", "block", "缺少二级章节（## 一、…）")
    elif first_h2_idx is not None and rules.get('require_sections', True):
        opening = ast.blocks[:first_h2_idx]
        intro_paras = [b for b in opening if b.kind == "paragraph"]
        bad = [b for b in opening if b.kind == "heading" and b.level >= 3]
        if bad:
            rpt.add("opening.no_subheading", "block",
                    "开头段（# 与第一个 ## 之间）不允许出现小标题",
                    bad[0].text)
        if not intro_paras:
            rpt.add("opening.has_text", "block", "开头段没有正文段落")

    # ---- ## 章节中文编号连续、末尾固定章节 ---------------------------
    h2s = ast.h2_sections()
    numbered = [b for b in h2s if b.text != ending]
    for i, sec in enumerate(numbered if rules.get("numbered_headings", True) else [], start=1):
        want = f"{cn_ordinal(i)}、"
        if not sec.text.startswith(want):
            rpt.add("h2.numbering", "block",
                    f"第 {i} 个章节应为「{want}」开头，实际是「{sec.text[:20]}」",
                    sec.text)
    if ending and (not h2s or h2s[-1].text != ending):
        rpt.add("h2.ending", "block",
                f"最后一个 ## 必须是固定结尾「{ending}」且不编号")

    # ---- ### 编号：每个 ## 内从 1. 重新编号 -------------------------
    current_h2: Block | None = None
    h3_counter = 0
    h4_counter = 0
    for b in ast.blocks:
        if b.kind == "heading" and b.level == 2:
            current_h2 = b
            h3_counter = 0
            h4_counter = 0
        elif b.kind == "heading" and b.level == 3 and rules.get("numbered_headings", True):
            h3_counter += 1
            h4_counter = 0
            m = _H3_NUM_RE.match(b.text)
            if not m:
                rpt.add("h3.numbering", "block",
                        f"「{current_h2.text if current_h2 else '?'}」下的小节"
                        f"「{b.text[:20]}」应使用「1. 标题」形式编号")
            elif int(m.group(1)) != h3_counter:
                rpt.add("h3.numbering", "block",
                        f"小节编号应连续递增：期望 {h3_counter}，"
                        f"实际 {m.group(1)}（{b.text[:20]}）")
        elif b.kind == "heading" and b.level == 4 and rules.get("numbered_headings", True):
            h4_counter += 1
            if not _H4_NUM_RE.match(b.text):
                rpt.add("h4.numbering", "warn",
                        f"扫读小标题「{b.text[:20]}」应使用 ① ② 形式编号"
                        "（2000 字左右短文可省略 #### 层）")
            else:
                order = "①②③④⑤⑥⑦⑧⑨⑩"[h4_counter - 1] \
                    if h4_counter <= 10 else "?"
                if not b.text.startswith(order):
                    rpt.add("h4.numbering", "warn",
                            f"扫读小标题编号应连续：期望 {order}，"
                            f"实际 {b.text[:1]}")
    if any(b.level >= 5 for b in ast.headings(5, 6)):
        rpt.add("heading.depth", "warn", "出现五级及以下标题，超出模板层级")

    # ---- 结尾三件套 + 品牌句 ---------------------------------------
    ending_blocks = _blocks_after(ast, ending) if ending else []
    ending_text = "\n".join(b.text for b in ending_blocks if b.kind == "paragraph")
    if ending_blocks:
        if triad.get("ice_recap_keyword") and triad["ice_recap_keyword"] not in ending_text:
            rpt.add("ending.triad", "block",
                    f"「{ending}」缺少 ICE 循环回顾（关键词：{triad['ice_recap_keyword']}）")
        if triad.get("preview_keyword") and triad["preview_keyword"] not in ending_text:
            rpt.add("ending.triad", "block",
                    f"「{ending}」缺少下期预告（关键词：{triad['preview_keyword']}）")
        if triad.get("answer_promise_keyword") and triad["answer_promise_keyword"] not in ending_text:
            rpt.add("ending.triad", "block",
                    "「写在最后」需承诺下期公布本期动手环节参考答案"
                    f"（关键词：{triad['answer_promise_keyword']}）")
        if triad.get("follow_keyword") and triad["follow_keyword"] not in ending_text:
            rpt.add("ending.triad", "block", "「写在最后」缺少一句关注引导")
    pattern = rules.get("brand_sentence_pattern", "")
    brand_re = re.compile(re.escape(pattern).replace(re.escape("{X}"), ".+?"))
    if pattern and not brand_re.search(ending_text if ending else ast.body_text()):
        rpt.add("ending.brand_sentence", "block",
                f"缺少配置的结尾品牌句「{pattern}」")

    # ---- 代码块数量 / 行数 / 注释 ----------------------------------
    # 演示代码与运行输出分栏：```text 围栏是 RunRecord 渲染的输出（§9.4），
    # 不计入「每篇 1-3 个代码块」的演示代码配额。
    codes = executable_code_blocks(ast)
    outputs = [b for b in ast.code_blocks()
               if b.lang.lower() in ("text", "output", "输出")]
    lo, hi = rules["code_blocks"]
    if not (lo <= len(codes) <= hi):
        rpt.add("code.count", "block", f"演示代码块应为 {lo}-{hi} 个，实际 {len(codes)} 个")
    max_lines = rules["code_block_max_lines"]
    cmt_lo, cmt_hi = rules["key_comment_lines"]
    for idx, c in enumerate(codes, start=1):
        nonblank = [ln for ln in c.lines if ln.strip()]
        if len(nonblank) > max_lines:
            rpt.add("code.max_lines", "block",
                    f"第 {idx} 个代码块 {len(nonblank)} 行（非空），超过 {max_lines} 行上限")
        n_cmt = code_comment_lines(c)
        if not (cmt_lo <= n_cmt <= cmt_hi):
            rpt.add("code.comments", "warn",
                    f"第 {idx} 个代码块关键注释 {n_cmt} 行，建议 {cmt_lo}-{cmt_hi} 行"
                    "（注释是否充分需人工判断）")
    if outputs and len(outputs) > len(codes):
        rpt.add("code.output_blocks", "warn",
                f"运行输出块 {len(outputs)} 个多于演示代码 {len(codes)} 个，"
                "请确认没有把输出当代码贴入")

    # ---- 图片占位符编号 --------------------------------------------
    figs = ast.image_placeholders()
    for i, b in enumerate(figs, start=1):
        if b.meta.get("figure_no") != i:
            rpt.add("figure.numbering", "block",
                    f"图片占位符编号应从图1 连续递增，第 {i} 个占位符写作"
                    f"「图{b.meta.get('figure_no')}」")
    if figs:
        cover = figs[0]
        if cover.meta.get("obtain_type") != "氛围" and cover.meta.get("figure_no") == 1:
            # 图1 是头图，按品牌规范走封面模板；类型标注错误仅提示
            rpt.add("figure.cover_type", "warn",
                    "图1 为头图，建议标注为「氛围」类型（品牌封面模板改字）")

    # ---- 字数 -------------------------------------------------------
    visible = ast.visible_chars()
    if target_words:
        wlo, whi = target_words
    else:
        wlo, whi = rules["words_range"]
    if visible < wlo * 0.8:
        rpt.add("words.range", "warn",
                f"可见字数 {visible} 低于目标下限 {wlo} 的八成")
    elif visible > whi * 1.3:
        rpt.add("words.range", "warn",
                f"可见字数 {visible} 超过目标上限 {whi} 的 1.3 倍")
    return rpt


def check_title_and_abstract(title: str, abstract: str,
                             profile: dict[str, Any]) -> RuleReport:
    """标题与摘要检查（§2.6：≤30 字、摘要 54-120 字）。

    摘要在标题工坊之后才生成；abstract 为空表示尚未进入该阶段，
    只提示不阻断。
    """
    rpt = RuleReport()
    rules = profile["article"]
    tlen = len(title.replace(" ", ""))
    if tlen == 0:
        rpt.add("title.nonempty", "block", "标题为空")
    elif tlen > rules["title_max_chars"]:
        rpt.add("title.length", "block",
                f"标题 {tlen} 字，超过 {rules['title_max_chars']} 字上限")
    alo, ahi = rules["abstract_chars"]
    alen = len(abstract.replace(" ", "").replace("\n", ""))
    if not abstract:
        rpt.add("abstract.pending", "info", "摘要尚未生成（标题工坊后产出）")
    elif not (alo <= alen <= ahi):
        rpt.add("abstract.length", "block",
                f"摘要 {alen} 字，应在 {alo}-{ahi} 字之间")
    return rpt


def _blocks_after(ast: ArticleAST, heading_text: str) -> list[Block]:
    out: list[Block] = []
    on = False
    for b in ast.blocks:
        if b.kind == "heading" and b.level == 2:
            on = b.text == heading_text
            continue
        if on and b.kind in ("paragraph", "image"):
            out.append(b)
    return out
