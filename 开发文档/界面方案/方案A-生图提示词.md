# 方案 A 生图提示词

使用内置 `imagegen` 生成。本文件保存本轮使用的提示词，供后续修改参考。生成结果是界面概念图；没有据此实现软件功能。

```text
Use case: ui-mockup.
Generate ONE original high-fidelity desktop application UI concept screenshot, wide landscape 16:10 aspect ratio, approximately 1920 by 1200 pixels. It is a Chinese editorial AI assistant named "ICE Loop Studio". The user wants a Codex-like interaction structure: persistent conversations at left, an AI editing discussion in the middle, a live article/diff preview on the right. Design an original branded app; do not reproduce OpenAI logos or any real Codex screenshot. This is a writing and editorial workflow app, NOT a programming IDE.

Visual style: restrained professional editorial workspace, exceptionally clear Chinese typography similar to Source Han Sans SC, warm off-white #F3F2ED canvas, near-black #15191F text, signal blue #2448DB only for selected controls and the main action, pale stone dividers #D8DBE2. Flat solid colors, no gradients, no shadows, no 3D, no device mockup, no decorative robots, no stock imagery, no invented graphical brand mark. Brand name in plain text with exact capitalization "ICE Loop Studio". Compact typography, generous but practical spacing. Pixel-crisp interface, aligned baseline grids, neat 1px dividing lines. Full straight-on screenshot, all panes visible, no perspective.

Overall composition:
A slim desktop title bar at the top; below it a left sidebar about 240px wide, a larger middle conversation workspace around 930px wide, a right article preview about 690px wide. Visually prioritize the conversation, make right preview comfortable to read. All UI labels and content are simplified Chinese except the brand and PY / 005. No source code, terminal, git, commit, programming-run buttons, debug panel, or technical implementation details.

Left sidebar:
At top brand text "ICE Loop Studio", then account dropdown "公众号：ICE Loop".
Primary blue outlined button "+ 新建对话".
Navigation rows "创作对话" (active), "文章审批" with small badge "2", "文章存稿", "配图资源箱", "网页工作台".
Separator, small muted label "最近会话".
Three conversation titles "PY/005 标题与开头" (selected with faint blue background), "工具周刊：观点讨论", "修改文章的结尾".
Bottom rows "公众号与品牌", "模型与设置"; a small plain-text brand tagline "可执行的想象。".

Middle pane:
Top header "PY / 005 · 标题与开头" and muted short subline "围绕这篇文章讨论，确认后再同步".
Context chips immediately below: "引用文章 4 篇", "栏目选题大纲", "品牌规范".
A clean conversation thread with one user message and one useful assistant response. User message verbatim:
"帮我拟定下一期标题，延续前几篇的学习进度，并优化开头。"
Assistant short reply verbatim:
"上一期讲条件判断，这一期适合推进到循环。建议沿用预设方向，用九九乘法表展开。"
Below assistant reply show a neat title proposal card, header "标题候选", 3 selectable stacked rows:
"for 和 while：让电脑替你重复干活" selected, small pill "推荐";
"写一张九九乘法表，把循环学明白";
"总在重复写代码？试试 for 和 while".
Small link "查看全部 6 个标题".
Then a thin inline workflow status "分析历史 ✓   拟题 ✓   改稿 ✓   待同步".
Then a strong but understated artifact card heading "候选稿 v3", subline "调整了标题、开头两段和下期预告". Two visible action buttons "查看差异" (secondary) and "同步至文章审批" (primary solid signal blue). This action is the most prominent button in the screenshot. This is a candidate version, never imply it is published or already approved.
At the bottom anchored chat composer, generous 110px height, placeholder:
"讨论观点，或告诉我想怎样修改文章…"
Composer small buttons "+ 引用文章", "+ 附件", mode selector "改稿", model selector "写作模型", a small blue send arrow at right.

Right pane:
Header "文章预览" with adjacent tabs "修改对比" and "配图".
Small status pill "候选草稿 · 未审批".
Small metadata "PY / 005" followed by large readable article heading split naturally into at most 2 lines:
"for 和 while：让电脑替你重复干活"
Two short readable paragraphs:
"上一篇，我们用条件判断处理了不同的车票情况。"
"这一次，从一张九九乘法表开始，让电脑把重复的事情做完。"
A hairline divider; subheading "开头修改".
A subtle red-tinted removed short line with strike-through:
"今天我们来学习循环。"
A pale-blue inserted block:
"如果要输出一百行相似的内容，难道要写一百次？循环就是为这个问题准备的。"
Below show compact source citation chips "引用：PY/004" and "栏目大纲".
A low-height footer strip "文章区 v2 → 对话候选 v3" and muted sentence "同步后进入审批，你仍可手工修改".
Bottom corner tiny understated text "概念设计 · 示例内容".

Do not add marketing hero sections, charts, generic SaaS dashboard widgets, cost statistics, or floating panels. This image must convincingly look like a working desktop writing assistant screenshot with readable concise Chinese, clear hierarchy, a friendly practical conversational editor, and visible safe handoff to article approval.
```
