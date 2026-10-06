"""离线确定性内容生成器（MockAdapter 的内容源）。

用途：开发联调、测试与离线 demo。产出的正文按 ICE Loop 规范手工撰写，
能通过规则引擎全部阻断项；代码块由 execution runner 真实执行，
输出经 integrate_evidence 从 RunRecord 回填，Mock 不伪造运行结果。
"""
from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------- 教学样例

_CANON_CODE: dict[tuple[str, int], list[dict[str, str]]] = {
    ("PY", 5): [
        {
            "run": "run-1", "filename": "for_demo.py", "lang": "python",
            "caption": "for_demo.py：range 与累加",
            "stdin": "",
            "code": (
                "# range(1, 6) 依次取出 1 到 5\n"
                "for i in range(1, 6):\n"
                "    print(f\"第 {i} 次循环\")\n"
                "\n"
                "# total 先归零，再一点点累加\n"
                "total = 0\n"
                "for n in range(1, 6):\n"
                "    total += n\n"
                "print(\"1 到 5 的和是\", total)\n"
            ),
        },
        {
            "run": "run-2", "filename": "guess_while.py", "lang": "python",
            "caption": "guess_while.py：猜数字到猜对为止",
            "stdin": "3\n7\n",
            "code": (
                "# 答案固定为 7，猜对就停\n"
                "answer = 7\n"
                "guess = 0\n"
                "# 条件不成立时，循环自动结束\n"
                "while guess != answer:\n"
                "    guess = int(input(\"猜一个 1-10 的整数：\"))\n"
                "    if guess != answer:\n"
                "        print(\"再试一次\")\n"
                "    else:\n"
                "        print(\"猜对了\")\n"
            ),
        },
        {
            "run": "run-3", "filename": "multiplication_table.py", "lang": "python",
            "caption": "multiplication_table.py：九九乘法表",
            "stdin": "",
            "code": (
                "# 外层循环管行，内层循环管列\n"
                "for row in range(1, 10):\n"
                "    line = \"\"\n"
                "    for col in range(1, row + 1):\n"
                "        # \\t 让每一列对齐\n"
                "        line += f\"{col}×{row}={row * col}\\t\"\n"
                "    print(line)\n"
            ),
        },
    ],
}

_CANON_TITLES: list[dict[str, Any]] = [
    {
        "title": "for 和 while：让电脑替你重复干活",
        "mechanism": "结果承诺型",
        "scores": {"清晰度": 5, "点击理由": 4, "具体性": 4, "悬念质量": 4, "可信度": 5},
        "total": 22,
        "primary_reason": "与排期表预设、PY/004 下期预告、封面标题三重一致",
    },
    {
        "title": "九九乘法表为什么是两层循环？",
        "mechanism": "问题诊断型",
        "scores": {"清晰度": 5, "点击理由": 5, "具体性": 5, "悬念质量": 4, "可信度": 5},
        "total": 24,
    },
    {
        "title": "打印 45 遍乘法口诀，代码只写 8 行",
        "mechanism": "结果承诺型（数字）",
        "scores": {"清晰度": 4, "点击理由": 5, "具体性": 5, "悬念质量": 3, "可信度": 4},
        "total": 21,
    },
    {
        "title": "不知道要循环几次，用什么？",
        "mechanism": "判断/选择型",
        "scores": {"清晰度": 5, "点击理由": 4, "具体性": 3, "悬念质量": 4, "可信度": 5},
        "total": 21,
    },
    {
        "title": "从手写五行到自动五遍：for 登场",
        "mechanism": "对比/冲突型",
        "scores": {"清晰度": 4, "点击理由": 4, "具体性": 4, "悬念质量": 3, "可信度": 5},
        "total": 20,
    },
    {
        "title": "让电脑替你重复干活：两种循环入门",
        "mechanism": "结果承诺型",
        "scores": {"清晰度": 4, "点击理由": 3, "具体性": 3, "悬念质量": 3, "可信度": 5},
        "total": 18,
    },
]


def canon_code(series: str, episode: int) -> list[dict[str, str]]:
    return _CANON_CODE.get((series, episode), [])


# ---------------------------------------------------------------- 结构化


def generate_structured(node: str, ctx: dict[str, Any]) -> dict[str, Any]:
    if node == 'creative_chat':
        clarification = ctx.get('clarification') or {}
        if ctx.get('mode') == 'draft' and ctx.get('fixture_clarification') and not (clarification.get('answers') or clarification.get('freeform_answer')):
            return {'reply': '缺少关键资料，先确认后再写。', 'title': '', 'body': '', 'prompts': [],
                    'questions': [{'id': 'audience', 'question': '这篇文章面向什么水平的读者？',
                                   'options': ['零基础在校学生', '已有编程经验的读者']},
                                  {'id': 'example', 'question': '你希望使用哪一种案例？',
                                   'options': ['九九乘法表', '倒计时']}]}
        target = ctx.get('candidate_article') or ctx.get('target_article') or {}
        title = target.get('title') or 'for 和 while：让电脑替你重复干活'
        body = target.get('body') or ('# ' + title + '\n\n每次都写一遍同样的操作，会让代码变长。循环让重复变得清楚。\n\n'
            '## 一、先确定要重复什么\n\n从九九乘法表开始，把行与列分别交给循环。\n\n'
            '![图1：循环封面](待配图：生图｜用户在TapNow生成)\n\n'
            '## 写在最后\n\n这里只是隔离测试候选稿，实际事实与配图仍需核验。')
        return {'reply': '这是离线测试候选：已整理标题、开头和配图提示词，等待同步审批。',
                'title': title, 'body': body, 'prompts': ['Use case: editorial cover for a beginner programming article; 16:9 canvas; signal blue #2448DB, ink black #15191F, warm white #F3F2ED; text exactly "for & while"; an orderly multiplication grid on the right and spacious title area on the left; flat editorial vector style; no 3D, gradients, shadows, product logos or watermark.']}
    if node=='image_prompts':
        return {'figures':[{'figure_no':s['figure_no'],
            'layout':'Use a restrained editorial grid. Place the main concept at the left and its result at the right, connected by one clear arrow. Keep the supplied identity unchanged and leave wide margins.',
            'exact_text':[s['caption']]} for s in ctx['figures']]}
    fn = {
        "topic": _topic_payload,
        "research": _research_payload,
        "outline": _outline_payload,
        "article_review": _article_review_payload,
        "style_review": _style_review_payload,
        "title_workshop": _titles_payload,
        "asset_plan": _asset_plan_payload,
        "abstract": _abstract_payload,
    }.get(node)
    if fn is None:
        return {"node": node, "note": "该节点由程序确定性处理，无需模型结构化输出"}
    return fn(ctx)


_ABSTRACTS: dict[tuple[str, int], str] = {
    ("PY", 5): (
        "for 与 while 是 Python 里两种重复干活的方式。这一篇用累加、猜数字和"
        "九九乘法表三个真实运行的例子，把「知道次数用 for、不知道用 while」"
        "讲清楚，最后留一道星号金字塔动手题，答案下期公布。"),
}


def _abstract_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    key = (ctx.get("series", "PY"), ctx.get("episode", 0))
    text = _ABSTRACTS.get(key) or (
        "这一篇围绕「" + ctx.get("topic", "本期主题") +
        "」做第一遍拆解：先说清场景，再给可复制的最小写法，全部输出来自真实运行，"
        "文末有动手题，参考答案下期公布。")
    return {"abstract": text}


def generate_text(node: str, ctx: dict[str, Any]) -> str:
    if node == 'creative_chat':
        return '可以接着上一篇的条件判断讨论循环。先明确重复次数，再比较 for 与 while 的使用场景。\n\n候选题目：\n\n1. for 和 while：让电脑替你重复干活\n2. 九九乘法表为什么需要两层循环\n3. 把重复的操作交给程序\n\n这是离线测试回复，实际创作使用已配置模型。'
    if node == "draft":
        return _draft_markdown(ctx)
    # 审稿修订类文本节点：Mock 场景下正文本已合规，回显原文表示「无需改动」
    if "draft" in ctx and isinstance(ctx["draft"], str):
        return ctx["draft"]
    return f"（Mock 文本输出：节点 {node}）"


# ------------------------------------------------------------------ 选题


def _topic_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    topic = ctx.get("topic", "")
    series = ctx.get("series", "PY")
    ep = ctx.get("episode", 1)
    directions = [
        {
            "文章类型": "教程指南",
            "工作量": "中（2000-2600 字）",
            "核心角度": f"围绕「{topic}」做从 0 到 1 的第一遍拆解，配可复制的最小示例",
            "标题候选": topic or f"{series} 第 {ep} 讲",
            "标题承诺": "读完能独立写出并跑通本篇的两个循环示例",
            "证据要求": "所有运行输出来自真实执行；不涉及版本号与价格",
            "风险": "示例难度要压在零基础可跟写的范围",
        },
        {
            "文章类型": "经验分享",
            "工作量": "轻（1500-2000 字）",
            "核心角度": "从初学者最容易卡住的边界条件切入，讲清「差一错误」",
            "标题候选": f"循环总是多跑一次？边界条件入门",
            "标题承诺": "能识别并修好最常见的 off-by-one 写法",
            "证据要求": "用一个真实的报错或错误输出做素材",
            "风险": "需要真实错误截图，不能编造",
        },
        {
            "文章类型": "实战评测",
            "工作量": "中（2000-3000 字）",
            "核心角度": "同一个任务分别用 for 与 while 实现，对比两种循环的适用场景",
            "标题候选": f"{topic}：for 和 while 怎么选",
            "标题承诺": "拿到一张选择两种循环的判断依据",
            "证据要求": "两段代码都要真实运行并附输出",
            "风险": "对比要公平，避免为讲 for 贬低 while",
        },
    ]
    return {
        "directions": directions,
        "working_title": topic or directions[0]["标题候选"],
        "recommended": 0,
        "recommend_reason": "与排期表预设及上一篇下期预告一致",
    }


def _research_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    claims: list[dict[str, Any]] = []
    for m in ctx.get("materials", []):
        tier = m.get("tier", 3)
        claims.append({
            "text": m.get("fact", m.get("title", "")),
            "risk_type": m.get("risk_type", "stable"),
            "source_ids": [m.get("source_id", "src-user")],
            "status": "verified" if tier <= 1 else "needs_check",
            "publish_day_check_required": m.get("risk_type") in
            ("version", "price", "quota", "model"),
        })
    if ctx.get("series") == "PY" and ctx.get("episode") == 5 and not claims:
        claims.append({
            "text": "九九乘法表按 1×1 到 9×9 计共 45 个算式",
            "risk_type": "stable",
            "source_ids": ["src-user"],
            "status": "verified",
            "publish_day_check_required": False,
        })
    return {"claims": claims}


# ------------------------------------------------------------------ 骨架


def _outline_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    series = ctx.get("series", "PY")
    ep = ctx.get("episode", 1)
    topic = ctx.get("topic", "")
    if (series, ep) == ("PY", 5):
        return {
            "working_title": topic or "for 和 while：让电脑替你重复干活",
            "opening": {
                "way": "问题痛点引入",
                "promise_reply_section": "## 一、在前两节内兑现「让电脑替你重复」的承诺",
            },
            "sections": [
                {"h2": "一、for 循环：把重复交给电脑",
                 "h3s": [
                     {"h3": "1. 基本写法：range 与缩进", "points": ["五行 print 的复制粘贴困境", "range 的含义"]},
                     {"h3": "2. 累加：一个变量当记事本", "points": ["total 的累加思路"]}],
                 "figures": [{"kind": "body_real", "position": "### 1 运行结果之后",
                              "caption": "for 循环运行结果", "obtain": "实截"}],
                 "code": ["for_demo.py"]},
                {"h2": "二、while 循环：不确定次数的重复",
                 "h3s": [
                     {"h3": "1. 条件成立就一直转", "points": ["while 与 if 的差别"]},
                     {"h3": "2. for 还是 while：怎么选", "points": ["选择依据"]}],
                 "figures": [{"kind": "body_real", "position": "### 1 运行结果之后",
                              "caption": "猜数字运行结果", "obtain": "实截"}],
                 "code": ["guess_while.py"]},
                {"h2": "三、九九乘法表：两层循环排排队",
                 "h3s": [{"h3": "1. 外层管行，内层管列", "points": ["嵌套循环的执行顺序"]}],
                 "figures": [{"kind": "body_diagram", "position": "### 1 代码讲解后",
                              "caption": "两层循环关系示意", "obtain": "生图"}],
                 "code": ["multiplication_table.py"]},
                {"h2": "四、动手环节：打印星号金字塔",
                 "h3s": [{"h3": "1. 题目与提示", "points": ["提示用两层循环"]}],
                 "figures": [], "code": []},
            ],
            "ending": {"ice_recap": True, "next_preview": "PY/006 列表：一次装下一串数据"},
        }
    # 通用骨架（其他主题的回退结构）
    return {
        "working_title": topic,
        "opening": {"way": "问题痛点引入", "promise_reply_section": "## 一、"},
        "sections": [
            {"h2": "一、先看问题", "h3s": [{"h3": "1. 场景还原", "points": []}],
             "figures": [], "code": []},
            {"h2": "二、动手实现", "h3s": [{"h3": "1. 代码与讲解", "points": []}],
             "figures": [], "code": []},
            {"h2": "三、动手环节", "h3s": [{"h3": "1. 题目", "points": []}],
             "figures": [], "code": []},
        ],
        "ending": {"ice_recap": True, "next_preview": "下期见"},
    }


# ------------------------------------------------------------------ 审校


def _article_review_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    return {
        "blocking": [],
        "warnings": [
            "第四节动手环节可再给一行星号示例，降低零基础读者的理解门槛",
        ],
        "patches": [],
        "fact_notes": "正文未出现版本号、价格、额度、模型名等高风险字段",
    }


def _style_review_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    return {
        "l1": {"passed": True, "hits": [], "note": "禁用词/禁用标点/套话零命中"},
        "l2": {
            "passed": True,
            "opening": "具体场景切入，无教科书式开头",
            "rhythm": "长短句交替，一句话独立成段不少于 3 处",
            "colloquial": "克制使用口语词，符合 ICE Loop 冷静人格",
            "punct": "冒号按品牌句式使用（卡兹克禁冒号裁定不适用），破折号 0 处",
        },
        "l3": {
            "passed": True,
            "support": "每个结论都跟着可运行的代码与真实输出",
            "knowledge": "知识点随案例顺手带出，无教科书式科普段",
        },
        "l4": {
            "passed": True,
            "temperature": "语气冷静有耐心，符合品牌人格",
            "posture": "陪伴练习的姿态，无导师腔",
            "flow": "通读无逻辑断点",
        },
        "total": "四层全部通过（Mock 预填；真实模型审稿时以模型输出为准）",
    }


# ------------------------------------------------------------- 标题工坊


def _titles_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    series = ctx.get("series", "PY")
    ep = ctx.get("episode", 1)
    if (series, ep) == ("PY", 5):
        return {
            "candidates": _CANON_TITLES,
            "recommended": 0,
            "recommend_reason":
                "主选候选 0 与排期表预设、PY/004 下期预告、封面标题三重一致；"
                "候选 1 总分更高，留作 A/B 备选",
        }
    topic = ctx.get("topic", "")
    return {
        "candidates": [
            {"title": topic, "mechanism": "结果承诺型",
             "scores": {"清晰度": 4, "点击理由": 3, "具体性": 3, "悬念质量": 3, "可信度": 5},
             "total": 18, "primary_reason": "与排期预设一致"},
        ],
        "recommended": 0,
        "recommend_reason": "离线 Mock 只有一名候选；接真实模型后应产出 5-10 名覆盖至少 4 种机制",
    }


# -------------------------------------------------------------- 资产计划


def _asset_plan_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    return {
        "note": "图位与获取方式由骨架决定；生图提示词由程序按七要素组装",
        "prompt_seeds": [
            {"use_case": "infographic-diagram",
             "exactly": "两层循环：行与列",
             "layout": "左列外层循环示意，右列内层循环示意，箭头自上而下"},
        ],
    }


# ------------------------------------------------------------------ 正文


def _draft_markdown(ctx: dict[str, Any]) -> str:
    series = ctx.get("series", "PY")
    ep = ctx.get("episode", 1)
    topic = ctx.get("topic", "")
    outline = ctx.get("outline") or _outline_payload(ctx)
    working_title = outline.get("working_title") or topic
    if (series, ep) == ("PY", 5):
        return _py005_markdown(working_title, ctx)
    return _generic_markdown(working_title, outline, ctx)


def _py005_markdown(title: str, ctx: dict[str, Any]) -> str:
    codes = canon_code("PY", 5)
    prev_answer = (ctx.get("exercise_to_answer") or "").strip()
    opening_answer = _opening_answer_paragraph(prev_answer)
    c0, c1, c2 = (codes + [{}] * 3)[:3]
    parts: list[str] = []
    parts.append(f"# {title}")
    parts.append("")
    parts.append(opening_answer)
    parts.append(
        "上周留给你的动手题，是把车票判定写成程序。小冰交上来的版本用了三个 if 分支，"
        "每种情况都判断了一次，能跑，思路也清楚。")
    parts.append("")
    parts.append("这一篇我们往前走一步，让代码学会「重复」。")
    parts.append("")
    parts.append(
        "先看一个场景。想打印 1 到 5，你现在要写五行 print。那打印 1 到 100 呢，"
        "复制粘贴九十五次？")
    parts.append("")
    parts.append("循环就是为这件事准备的。")
    parts.append("")
    parts.append("![图1：本期封面](待配图：氛围｜品牌封面模板改字（PY 系列）)")
    parts.append("")
    # ------------------------------------------------------ 一、for
    parts.append("## 一、for 循环：把重复交给电脑")
    parts.append("")
    parts.append(
        "for 循环的意思很直白，把一串东西挨个取出来，每取一个，就把缩进里的代码执行一遍。"
        "「挨个取」这三个字，就是它全部的脾气。")
    parts.append("")
    parts.append("### 1. 基本写法：range 与缩进")
    parts.append("")
    parts.append("新建 for_demo.py，照着敲一遍。")
    parts.append("")
    parts.append(f"```python\n{c0['code'].rstrip()}\n```")
    parts.append("")
    parts.append("运行结果是这样的。")
    parts.append("")
    parts.append(f"<!--RUN_OUTPUT:{c0['run']}-->")
    parts.append("")
    parts.append("![图2：for_demo.py 运行结果](待配图：实截｜终端运行 for_demo.py 后紧凑截取)")
    parts.append("")
    parts.append(
        "range(1, 6) 会依次给出 1、2、3、4、5。注意终点是 6 但取不到 6，"
        "这是初学者最容易踩的边界，记住「含头不含尾」。")
    parts.append("")
    parts.append("### 2. 累加：一个变量当记事本")
    parts.append("")
    parts.append(
        "下半段代码在做累加。total 先归零，循环每转一圈就把新的数字加进去，"
        "循环结束时它就记住了全部的和。这个「记事本」写法后面会反复用到。")
    parts.append("")
    # ------------------------------------------------------ 二、while
    parts.append("## 二、while 循环：不确定次数的重复")
    parts.append("")
    parts.append(
        "for 适合「知道要重复几次」的场景。可有时候你不知道次数，只知道一个条件，"
        "比如「没猜对就继续猜」。这种时候轮到 while 上场。")
    parts.append("")
    parts.append("### 1. 条件成立就一直转")
    parts.append("")
    parts.append(
        "写一个猜数字程序。答案固定为 7，猜对就停。新建 guess_while.py。")
    parts.append("")
    parts.append(f"```python\n{c1['code'].rstrip()}\n```")
    parts.append("")
    parts.append("在终端里先输入 3，再输入 7，输出是这样的。")
    parts.append("")
    parts.append(f"<!--RUN_OUTPUT:{c1['run']}-->")
    parts.append("")
    parts.append("![图3：猜数字运行结果](待配图：实截｜终端运行 guess_while.py 后紧凑截取)")
    parts.append("")
    parts.append(
        "while 后面跟一个条件，条件成立就执行缩进块，执行完回头再判断一次，"
        "直到条件不成立才放行后面的代码。它和 if 长得像，差别在于 if 只问一次，"
        "while 会一直问下去。")
    parts.append("")
    parts.append("### 2. for 还是 while：怎么选")
    parts.append("")
    parts.append(
        "给一个简单的判断办法。能用「从几到几」描述的重复，交给 for。"
        "只能用「直到某个条件不成立」描述的重复，交给 while。"
        "拿不准时先问自己知不知道循环次数，知道就用 for。")
    parts.append("")
    # ------------------------------------------------------ 三、乘法表
    parts.append("## 三、九九乘法表：两层循环排排队")
    parts.append("")
    parts.append(
        "单个循环你已经会了。现在把它叠一层，做一件真正有成就感的事，"
        "九九乘法表。")
    parts.append("")
    parts.append("### 1. 外层管行，内层管列")
    parts.append("")
    parts.append("新建 multiplication_table.py。")
    parts.append("")
    parts.append(f"```python\n{c2['code'].rstrip()}\n```")
    parts.append("")
    parts.append("运行后你会看到整齐的九行口诀。")
    parts.append("")
    parts.append(f"<!--RUN_OUTPUT:{c2['run']}-->")
    parts.append("")
    parts.append("![图4：两层循环关系示意](待配图：图示｜生图（P1）)")
    parts.append("")
    parts.append(
        "外层循环每取一个 row，内层就完整地跑一轮。内层的终点写成 row + 1，"
        "第几行就乘到几，这正是乘法表的形状。两层循环就是这样一层套一层工作的。")
    parts.append("")
    parts.append("这就是嵌套循环。")
    parts.append("")
    # ------------------------------------------------------ 四、动手
    parts.append("## 四、动手环节：打印星号金字塔")
    parts.append("")
    parts.append(
        "这周的动手题来了。用循环打印一个 5 行的星号金字塔，第 1 行 1 个星号，"
        "每往下一行多一个，第 5 行 5 个。")
    parts.append("")
    parts.append(
        "提示，一层循环管行，行内的空格和星号可以用字符串乘法（比如 \"*\" * 3），"
        "也可以再叠一层循环。小明的答案是两层循环，你的呢。")
    parts.append("")
    parts.append("把你的写法跑通，欢迎后台发给我看。")
    parts.append("")
    # ------------------------------------------------------ 写在最后
    parts.append("## 写在最后")
    parts.append("")
    parts.append(
        "按 ICE 循环回顾这一篇。Input 是五行 print 的重复困境，"
        "Code 是 for、while 和两层嵌套，Execution 是终端里真实的九行口诀。"
        "循环不是让电脑更聪明，是让它替你承担重复。")
    parts.append("")
    parts.append(
        "下期预告。PY/006 我们讲列表，一种能一次装下一串数据的类型，"
        "循环的好搭档。本期金字塔的参考答案，下期篇首发给你。")
    parts.append("")
    parts.append("如果这篇对你有用，欢迎关注 ICE Loop，我们下期见。")
    parts.append("")
    parts.append("**可执行的想象，从写下一层循环开始。**")
    parts.append("")
    return "\n".join(parts)


def _opening_answer_paragraph(prev_answer: str) -> str:
    if prev_answer:
        return f"上一篇的动手题你做了吗。参考答案这一篇开头先不发，先说正事，{prev_answer[:0]}"
    return "上一篇的动手题你做了吗。"


def _generic_markdown(title: str, outline: dict[str, Any], ctx: dict[str, Any]) -> str:
    parts = [f"# {title}", ""]
    parts.append("这一篇我们从一个小场景开始，把它拆开讲清楚。")
    parts.append("")
    parts.append("![图1：本期封面](待配图：氛围｜品牌封面模板改字)")
    parts.append("")
    idx = 2
    for sec in outline.get("sections", []):
        parts.append(f"## {sec['h2']}")
        parts.append("")
        for h3 in sec.get("h3s", []):
            parts.append(f"### {h3['h3']}")
            parts.append("")
            parts.append(
                "这一小节围绕上面的目标展开。先说清楚要做什么，再给最小可运行的写法，"
                "最后看真实输出。")
            parts.append("")
        if sec.get("figures"):
            for f in sec["figures"]:
                parts.append(f"![图{idx}：{f['caption']}](待配图：{f['obtain']}｜待补充)")
                parts.append("")
                idx += 1
    parts.append("## 写在最后")
    parts.append("")
    parts.append(
        "按 ICE 循环回顾。Input 是这一篇开头的场景，Code 是正文里的最小写法，"
        "Execution 是你终端里的真实输出。")
    parts.append("")
    parts.append(
        "下期预告见篇首约定，本期动手环节的参考答案下期篇首公布。")
    parts.append("")
    parts.append("如果这篇对你有用，欢迎关注 ICE Loop，我们下期见。")
    parts.append("")
    parts.append("**可执行的想象，从跑通这一篇开始。**")
    parts.append("")
    return "\n".join(parts)
