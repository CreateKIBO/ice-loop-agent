"""规则引擎测试：好文通过、各违规项阻断。"""
from __future__ import annotations

import unittest

from ice_agent.rules import parse_markdown, run_all_checks
from tests import load_profile

PROFILE = load_profile()


def good_article() -> str:
    return """# for 和 while：让电脑替你重复干活

上一篇的动手题你做了吗。这一篇我们往前走一步。

这一篇讲循环。

![图1：本期封面](待配图：氛围｜品牌封面模板改字)

## 一、for 循环

for 把一串东西挨个取出来。

### 1. 基本写法

照着敲一遍。

```python
# range(1, 6) 依次取出 1 到 5
for i in range(1, 6):
    print(i)
```

运行结果是这样的。

```text
1
2
3
4
5
```

![图2：运行结果](待配图：实截｜终端截取)

### 2. 累加

total 是记事本。

循环就到这里。

## 二、while 循环

条件成立就一直转。

## 写在最后

按 ICE 循环回顾。Input 是场景，Code 是写法，Execution 是输出。

下期预告。下一篇讲列表，本期参考答案下期公布。

欢迎关注 ICE Loop。

**可执行的想象，从写下一层循环开始。**
"""


def run(text: str, **kw):
    return run_all_checks(text, PROFILE, **kw)


class TestGoodArticle(unittest.TestCase):
    def test_passes(self):
        r = run(good_article())
        assert r["passed"], r["report"]["blocking"]

    def test_ast_counts(self):
        ast = parse_markdown(good_article())
        assert ast.h1() is not None
        assert len(ast.h2_sections()) == 3
        assert len(ast.image_placeholders()) == 2
        assert ast.visible_chars() > 100


class TestStructuralViolations(unittest.TestCase):
    def test_double_h1(self):
        text = good_article() + "\n# 第二个标题\n"
        assert not run(text)["passed"]

    def test_opening_has_subheading(self):
        text = good_article().replace("这一篇讲循环。", "### 小标题\n这一篇讲循环。")
        r = run(text)
        assert any(f["rule"] == "opening.no_subheading" for f in r["report"]["blocking"])

    def test_h2_numbering_skip(self):
        text = good_article().replace("## 二、while 循环", "## 三、while 循环")
        r = run(text)
        assert any(f["rule"] == "h2.numbering" for f in r["report"]["blocking"])

    def test_missing_ending(self):
        text = good_article().replace("## 写在最后", "## 五、总结")
        r = run(text)
        assert any(f["rule"] == "h2.ending" for f in r["report"]["blocking"])

    def test_h3_numbering(self):
        text = good_article().replace("### 2. 累加", "### 3. 累加")
        r = run(text)
        assert any(f["rule"] == "h3.numbering" for f in r["report"]["blocking"])

    def test_too_many_code_blocks(self):
        extra = "\n```python\nx = 1\n```\n" * 3
        text = good_article().replace("## 写在最后", extra + "\n## 写在最后")
        r = run(text)
        assert any(f["rule"] == "code.count" for f in r["report"]["blocking"])

    def test_code_block_too_long(self):
        long_code = "\n".join(
            [f"# 注释行" if i == 0 else f"print({i})" for i in range(25)])
        text = good_article().replace(
            "```python\n# range(1, 6) 依次取出 1 到 5\nfor i in range(1, 6):\n    print(i)\n```",
            f"```python\n{long_code}\n```")
        r = run(text)
        assert any(f["rule"] == "code.max_lines" for f in r["report"]["blocking"])

    def test_missing_brand_sentence(self):
        text = good_article().replace("**可执行的想象，从写下一层循环开始。**", "下次见。")
        r = run(text)
        assert any(f["rule"] == "ending.brand_sentence" for f in r["report"]["blocking"])

    def test_figure_numbering(self):
        text = good_article().replace("![图2：运行结果", "![图3：运行结果")
        r = run(text)
        assert any(f["rule"] == "figure.numbering" for f in r["report"]["blocking"])

    def test_output_fence_not_counted_as_code(self):
        """```text 运行输出块不计入演示代码配额。"""
        text = good_article() + "\n```text\n更多输出\n```\n"
        r = run(text)
        assert not any(f["rule"] == "code.count" for f in r["report"]["blocking"])

    def test_title_too_long(self):
        r = run(good_article(),
                title="这是一个特别特别特别特别特别特别特别长的标题超过三十个字会被拦下来")
        assert any(f["rule"] == "title.length" for f in r["report"]["blocking"])

    def test_abstract_range(self):
        r = run(good_article(), abstract="太短")
        assert any(f["rule"] == "abstract.length" for f in r["report"]["blocking"])
        ok = run(good_article(), abstract=(
            "这是一段长度合适的中规中矩的摘要文字，用来验证摘要字数检查"
            "在五十四到一百二十字之间可以通过，写满五十四个字符之后就"
            "应该放行，不再算作阻断问题。"))
        assert not any(f["rule"] == "abstract.length"
                       for f in ok["report"]["blocking"])


class TestBrandViolations(unittest.TestCase):
    def test_banned_brand_word(self):
        text = good_article().replace("这一篇讲循环。", "保姆级教程来了。")
        r = run(text)
        assert any(f["rule"] == "brand.banned_word" for f in r["report"]["blocking"])

    def test_l1_banned_phrase(self):
        text = good_article().replace("for 把一串东西挨个取出来。",
                                      "说白了，for 就是挨个取。")
        r = run(text)
        assert any(f["rule"] == "l1.banned_phrase" for f in r["report"]["blocking"])

    def test_dash(self):
        text = good_article().replace("total 是记事本。", "total——一个记事本。")
        r = run(text)
        assert any(f["rule"] == "punct.dash" for f in r["report"]["blocking"])

    def test_curly_quotes(self):
        text = good_article().replace("照着敲一遍。", "“照着敲一遍”。")
        r = run(text)
        assert any(f["rule"] == "punct.curly_quote" for f in r["report"]["blocking"])

    def test_emotional_punct(self):
        text = good_article().replace("循环就到这里。", "这也太快了？？？")
        r = run(text)
        assert any(f["rule"] == "punct.emotional" for f in r["report"]["blocking"])

    def test_not_but_is_limit(self):
        text = good_article().replace(
            "for 把一串东西挨个取出来。",
            "循环不是魔法，是重复。for 不是别的，是挨个取。")
        r = run(text)
        assert any(f["rule"] == "style.not_but_is" for f in r["report"]["blocking"])

    def test_private_repo_link(self):
        text = good_article().replace(
            "欢迎关注 ICE Loop。",
            "完整代码见 github.com/CreateKIBO/python-zero-to-one。欢迎关注 ICE Loop。")
        r = run(text)
        assert any(f["rule"] == "boundary.private_repo" for f in r["report"]["blocking"])

    def test_fixed_schedule_promise(self):
        text = good_article().replace(
            "欢迎关注 ICE Loop。", "我们每周一更新，欢迎关注 ICE Loop。")
        r = run(text)
        assert any(f["rule"] == "boundary.fixed_schedule" for f in r["report"]["blocking"])

    def test_duration_promise(self):
        text = good_article().replace(
            "循环就到这里。", "10 分钟就能学会循环。循环就到这里。")
        r = run(text)
        assert any(f["rule"] == "boundary.duration_promise"
                   for f in r["report"]["blocking"])

    def test_wk_price_number(self):
        text = good_article().replace("total 是记事本。", "会员 20 元一个月。")
        r = run(text, series="WK")
        assert any(f["rule"] == "wk.price_number" for f in r["report"]["blocking"])

    def test_wk_requires_weekly_code(self):
        r = run(good_article(), series="WK")
        assert any(f["rule"] == "wk.weekly_code" for f in r["report"]["blocking"])


class TestFacts(unittest.TestCase):
    def test_version_without_claim_blocks(self):
        text = good_article().replace("for 把一串东西挨个取出来。",
                                      "Python 3.12 里 for 挨个取。")
        r = run(text)
        assert any(f["rule"] == "fact.high_risk" for f in r["report"]["blocking"])

    def test_version_with_verified_claim_passes(self):
        text = good_article().replace("for 把一串东西挨个取出来。",
                                      "Python 3.12 里 for 挨个取。")
        claims = [{"text": "Python 3.12 里 for 挨个取", "risk_type": "version",
                   "status": "verified", "source_ids": ["official"],
                   "verified_at": "2026-10-01T12:00:00+08:00", "review_notes": "官方文档原文核对",
                   "evidence_verified": True}]
        r = run(text, claims=claims)
        assert not any(f["rule"] == "fact.high_risk" for f in r["report"]["blocking"])
