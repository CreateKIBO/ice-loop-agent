"""品牌与风格规则：ICE Loop 冷静人格 + khazix-writer L1 的适配版。

适配裁定（AGENTS.md / 设计文档 §3.1）：卡兹克的情绪标点（。。。/？？？）
与全面禁冒号不适用于 ICE Loop；品牌常用句式本身带冒号，故冒号放行，
破折号 0 处、西文弯引号禁用（一律「」）、情绪标点禁用。
"""
from __future__ import annotations

import re

from .markdown_ast import ArticleAST
from .structural import RuleReport

_NOT_BUT_IS = re.compile(r"不是[^。，；\n]{1,14}[，,](?:而?是)")
_REPO_LINK = re.compile(r"github\.com/CreateKIBO|python-zero-to-one|java-level-up", re.I)
_REPO_PROMISE = re.compile(r"仓库链接|源码仓库|后台回复.{0,6}(源码|代码|链接)")
_FIXED_SCHEDULE = re.compile(
    r"每周[一二三四五六日天][^。\n]{0,12}(更新|推送|发文)|固定更新|每天更新|固定四更")
_DURATION_PROMISE = re.compile(r"(\d+)\s*(分钟|小时)[^。\n]{0,8}(搞定|学会|完成|入门|上手)")
_PRICE = re.compile(
    r"[¥$]\s*\d|(\d+)\s*元|\d+\s*美元|每月\s*\d+\s*次|免费版|完全免费|永久免费")
_VERSION_NUM = re.compile(r"[vV]?\d+\.\d+(?:\.\d+)?")
_ENGLISH_SENT = re.compile(r"[\u4e00-\u9fff]")


def check_brand(ast: ArticleAST, profile: dict[str, Any],
                series: str = "") -> RuleReport:
    """品牌红线与 L1 适配检查；series 为栏目代码（WK 有额外规则）。"""
    rpt = RuleReport()
    body = ast.body_text()          # 不含代码块与图片占位符
    title = ast.h1().text if ast.h1() else ""

    # ---- 品牌禁用表达 ------------------------------------------------
    for word in profile["banned_brand_words"]:
        for hit in _find(body + "\n" + title, word):
            rpt.add("brand.banned_word", "block", f"品牌禁用表达命中：「{word}」", hit)

    # ---- L1 禁用词（article-craft 4.3 + khazix L1 的 ICE 适配）-------
    for word in profile["banned_ai_phrases"]:
        for hit in _find(body, word):
            rpt.add("l1.banned_phrase", "block", f"L1 禁用词命中：「{word}」", hit)
    for pat in profile["banned_patterns"]:
        for m in re.finditer(pat, body):
            rpt.add("l1.banned_pattern", "block",
                    f"结构性套话命中：{m.group(0)}", m.group(0))

    # ---- 标点纪律 ----------------------------------------------------
    pun = profile["banned_punctuation"]
    dash_n = body.count(pun["dash"])
    if dash_n > profile["article"]["max_dash"]:
        rpt.add("punct.dash", "block",
                f"破折号「——」出现 {dash_n} 处，最多允许 {profile['article']['max_dash']} 处")
    for q in pun["curly_quotes"]:
        if q in body:
            rpt.add("punct.curly_quote", "block",
                    "发现西文弯引号，引用一律使用「」", body[:0])
    for emo in pun["emotional"]:
        if emo in body:
            rpt.add("punct.emotional", "block",
                    f"情绪标点「{emo}」不符合当前账号规范")

    # ---- 句式纪律 ----------------------------------------------------
    n_nbi = len(_NOT_BUT_IS.findall(body))
    if n_nbi > profile["article"]["max_not_but_is_pattern"]:
        rpt.add("style.not_but_is", "block",
                f"「不是X，是Y」结构出现 {n_nbi} 次，每篇最多 {profile['article']['max_not_but_is_pattern']} 次")

    short_paras = _count_single_sentence_paragraphs(ast)
    if short_paras < profile["article"]["min_short_paragraphs"]:
        rpt.add("style.short_paragraph", "warn",
                f"一句话独立成段仅 {short_paras} 处，建议不少于 "
                f"{profile['article']['min_short_paragraphs']} 处（形成节奏停顿）")

    # ---- 发布边界 ----------------------------------------------------
    if profile.get("profile") == "ice-loop" and _REPO_LINK.search(body):
        rpt.add("boundary.private_repo", "block",
                "正文出现私有仓库链接（私有仓库仅归档，正文不放链接）")
    if profile.get("profile") == "ice-loop" and _REPO_PROMISE.search(body):
        rpt.add("boundary.repo_promise", "block",
                "出现仓库/资料领取承诺；未就绪的资料不挂领取钩子")
    if profile.get("profile") == "ice-loop" and _FIXED_SCHEDULE.search(body):
        if not _is_internal_note(body):
            rpt.add("boundary.fixed_schedule", "block",
                    "对外文案不得承诺固定更新日（内部排期另存）",
                    _FIXED_SCHEDULE.search(body).group(0))
    m = _DURATION_PROMISE.search(body)
    if m:
        rpt.add("boundary.duration_promise", "block",
                f"无依据的时长承诺：「{m.group(0)}」（无实测支撑不写时长承诺）",
                m.group(0))

    # ---- WK 工具周刊附加规则 ----------------------------------------
    if series == "WK":
        wk = profile.get("wk_extra_rules", {})
        if wk.get("zero_price_numbers"):
            for m2 in _PRICE.finditer(body):
                rpt.add("wk.price_number", "block",
                        f"工具类文章零价格零额度数字：「{m2.group(0)}」"
                        f"（标注「以官网为准」）", m2.group(0))
        if wk.get("require_official_note") and wk["require_official_note"] not in body:
            # 以官网为准 通常写在 02 检查清单；正文没有只提示
            rpt.add("wk.official_note", "info",
                    "提醒：02 发稿前检查清单需包含「以官网为准」与当天核验项")
        if wk.get("require_weekly_code_section") and wk["require_weekly_code_section"] not in body:
            rpt.add("wk.weekly_code", "block",
                    f"工具周刊必带「{wk['require_weekly_code_section']}」栏目")
    return rpt


def check_l1_quiet(title: str, profile: dict[str, Any]) -> RuleReport:
    """标题专项：禁用最全/终极/颠覆/必看/100%/震惊体（标题工坊 8.3）。"""
    rpt = RuleReport()
    banned_title = profile.get('title_banned_words', ["最全", "终极", "颠覆", "必看", "100%", "震惊"])
    for w in banned_title:
        if w in title:
            rpt.add("title.banned_word", "block", f"标题禁用词：「{w}」")
    if "？" in title and not _ENGLISH_SENT.search(title):
        pass  # 中文标题问号允许（诊断式标题）
    return rpt


# ------------------------------------------------------------------ 工具


def _find(text: str, word: str) -> list[str]:
    return [m.group(0) for m in re.finditer(re.escape(word), text)][:3]


def _count_single_sentence_paragraphs(ast: ArticleAST) -> int:
    """一句话独立成段：段落非空、≤30 字、以句号/问号结尾且只有一句。"""
    n = 0
    for b in ast.paragraphs():
        t = b.text.strip()
        if not t or len(t) > 30:
            continue
        if t.endswith(("。", "？", "！")) and t.count("。") + t.count("？") + t.count("！") <= 1:
            if not t.startswith(("|", ">", "-", "*")):   # 表格/列表不算
                n += 1
    return n


def _is_internal_note(body: str) -> bool:
    """「内部按排期执行」的说明段不算对外承诺（ heuristic：紧邻内部标注）。"""
    return "内部" in body[:120]
