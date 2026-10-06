# Content Studio / ICE Loop Agent v1.5.2

v1.5.2 将「AI 调用预算」置于模型设置首屏和窗口顶部，支持独立调整已有文章预算，并修复旧补图任务零预算及提示词重拟未恢复模型快照的问题。统一按钮、表单、弹窗与长内容操作栏，增加本地 Motion 悬停/按压/页面过渡、忙碌状态与可恢复的错误提示；修复复选框继承普通输入框最小高度导致的对齐问题。

最新说明：[v1.5.2 预算与交互](docs/v1.5.2-升级说明.md)，验收：[v1.5.2 实际记录](docs/v1.5.2-验收结果.json)。安装包：[ICE-Loop-Studio-1.5.2-Setup.exe](release/ICE-Loop-Studio-1.5.2-Setup.exe)；免安装包：[ICE-Loop-Studio-1.5.2-x64.zip](release/ICE-Loop-Studio-1.5.2-x64.zip)。先保存正在编辑的内容，安装/解压到非C盘目录。下文保留历史版本说明。

v1.5.0 接入本地 Motion 开源动效库，统一暖白编辑工作台样式，改善侧栏、快捷搜索、文稿专注阅读、输入恢复与真实进度反馈。支持快速搜索重开、首条消息自动衔接、生成期间保留新输入，以及内置网页的 Ctrl K 与自适应布局。保留 v1.4.1 的初稿修复、审批和可恢复的会话/任务管理。

v1.5.1 按用户批准的原始视觉资产与 AI/001 提示词修正配图：封面按栏目模板编辑，仅改标题与期号；正文图明确文字与构图；编辑器显示参考图上传顺序。网页工作台默认收起说明，可一键扩大网页区域并恢复，不重置网页与登录会话。同时修复数据库读连接重复写版本标记引发的生成并发锁竞争。

最新操作说明：[v1.5.1 升级说明](docs/v1.5.1-升级说明.md)。实际验收：[v1.5.1 验收记录](docs/v1.5.1-验收结果.json)。[提示词示例](docs/v1.5.1-提示词示例.md)。整体体验见 [v1.5 升级说明](docs/v1.5-升级说明.md)，参考产品和动效库见 [v1.5 调研](docs/v1.5-research.md)。此前问题修复见 [v1.4.1 修复说明](docs/v1.4.1-修复说明.md)。

本版安装包：[ICE-Loop-Studio-1.5.1-Setup.exe](release/ICE-Loop-Studio-1.5.1-Setup.exe)；免安装包：[ICE-Loop-Studio-1.5.1-x64.zip](release/ICE-Loop-Studio-1.5.1-x64.zip)。先保存未完成编辑，再运行安装包。建议安装/解压到非 C 盘目录。

以下保留历史版本说明；最新入口和安装包以开头的 v1.5.2 为准。

v1.2.0新增自动准备模式，自动拟题、写稿和配图提示词，完成后统一审阅；支持当前公众号视觉规范和风格参考、7张正式ICE Loop资产幂等导入、提示词编辑保护和DeepSeek视觉模型。真实运行记录自动截图；本机新代码仍须审阅，Docker隔离模式可自动执行。TapNow生图与公众号发布仍手动。详见[使用说明](docs/v1.2-自动准备与配图风格.md)。

TapNow 默认使用中国站首页：`https://app.tapnow.media/home`，通过程序内 Chromium 打开。

v1.1.1 修复安装升级：安装前自动关闭正在运行的 Agent，等待后台引擎和浏览器子进程退出，必要时结束已确认身份的残留进程；不按 Python/Electron 名称批量关闭无关程序。旧安装目录内的工作区会暂存到目录外，完成升级后放回原路径，避免旧卸载器清理时连带删除文章数据。安装载荷使用带结果检查的 ZIP 直接解压。

当前安装包：`release/ICE-Loop-Studio-1.2.0-Setup.exe`；免安装包：`release/ICE-Loop-Studio-1.2.0-x64.zip`。先保存未完成编辑，再运行安装包，无需手动结束 Agent。

最新说明：[v1.1.1 安装升级修复](docs/v1.1.1-安装升级修复.md)。[实际验收](docs/v1.1.1-验收结果.json)：独立安装标识与目录内完成旧模板安装、运行中升级、数据恢复、原数据库重启、首次安装和测试卸载；用户实际 E 盘安装未作为测试目标。原生关闭、工作区恢复专项与 29 项前端测试通过。

以下保留 v1.1 浏览器/导出功能与之前的历史说明。

v1.1 新增程序内的「网页工作台」：TapNow 和微信公众号后台都在随程序提供的 Chromium 内打开，资源箱中的 TapNow 按钮也进入这里。支持导航、登录子窗口和下载保存，各公众号、各站点分开保存会话。无需安装系统 Chrome。

默认导出现在是「发布包」，顶层只有 `文本/` 与 `图片/`：UTF-8 Markdown 正文、纯文本发布说明，以及当前已审核选用的配图。内部证据归档和 HTML 预览继续单独保留。MD 需在你的排版工具中处理后粘贴到微信后台，图片手动上传。

新版安装包：`release/ICE-Loop-Studio-1.1.0-Setup.exe`；免安装包：`release/ICE-Loop-Studio-1.1.0-x64.zip`，完整解压到非 C 盘目录后运行 `ICE Loop Studio.exe`。

最新操作与升级说明：[v1.1 内嵌浏览器与手动发布](docs/v1.1-内嵌浏览器与手动发布.md)。[本次实际验收记录](docs/v1.1-验收结果.json)：53 项相关 Python 回归、29 项 Node、打包后的完整桌面与原生浏览器流程通过；真实 TapNow 首页和微信扫码登录页加载成功。账号登录、生图、微信粘贴与发布由用户操作，未在测试中代为执行。

下面保留 v1.0 功能和历史版本说明。v1.0 外部 TapNow 入口在 v1.1 已替换为内嵌入口，默认导出目录以新版说明为准。

已提供 Windows x64 安装程序与免安装 ZIP，运行桌面程序不再需要开发用的 Node.js、uv 或 Python 虚拟环境。教学 Python 随程序提供；运行 Java 示例仍需要本机 JDK，Docker 隔离模式需自行安装 Docker 并准备镜像。

v1.0 修复交互代码反复审阅：缺少输入会逐段提示，源码、输入、预期报错与执行方式共同绑定授权，成功运行的片段保存后可复用。增加源码修改与明确切换执行方式、规则来源/冲突、Windows 选定窗口与网页截图、确定性封面文字、裁切遮挡、单图重做、任意双版本比较、语义复审、富文本复制、诊断、自检、Git 预览归档与应用内提醒。增加 MiniMax 原厂预置与服务端点设置。

安装包：`release/ICE-Loop-Studio-1.0.0-Setup.exe`。免安装包：`release/ICE-Loop-Studio-1.0.0-x64.zip`，完整解压到非 C 盘目录后双击 `ICE Loop Studio.exe`。

v1.0 操作、迁移与当时的实际验收边界：[v1.0 使用与验收](docs/v1.0-使用与验收.md)。设计任务对照见上一级 `开发文档/开发实现进度-v1.0.md`。TapNow 按用户选择保留手动网站流程；真实模型连接以重新保存 Key 后的测试结果为准。

下面保留历史版本说明与源码开发入口；安装包用户无需执行源码安装脚本。

v0.8 修复栏目历史拟题：当前栏目、所选期号此前最近五期正文，加该栏目的全部历史标题。
新增「栏目选题大纲」，可读取 Markdown/TXT/DOCX，预览修改后按栏目和期号保存。
新建文章可以选预设期题或自己拟题；修改确认后锁定为最终标题，跳过 AI 拟题。
每栏目支持 1–9999 期，单次导入最多 1000 条，可多次追加。

最新说明：[v0.8 栏目历史与选题大纲](docs/v0.8-editorial-topics.md)。
可编辑导入模板：[栏目选题大纲示例](docs/栏目选题大纲-示例.md)。
设计任务对照与本轮进度见上一级 `开发文档/开发实现进度-v0.8.md`。

v0.7 新增「导入文章补图」：原稿快照只读、配图计划编辑、逐张候选接受/否决，
审阅原稿示例后真实运行截图，复用资源或手动 TapNow，另存补图文章包。
标题、期号和既有文字不改写；图片全部齐全仍提示正文待审核。

历史说明：[v0.7 已有文章补图与候选审核](docs/v0.7-supplements.md)。
设计任务对照与剩余功能见上一级 `开发文档/开发实现进度-v0.7.md`。

v0.6 按开发文档补齐：正文版本浏览、逐行差异与恢复；带已审核图片和品牌配色的
独立 HTML 预览；全公众号本地备份、包校验与恢复到新目录。恢复正文后需复检，
恢复工作台后需重启和重新配置模型 Key。TapNow 延续手动网站生图流程。

历史说明：[v0.6 版本、HTML 与备份](docs/v0.6-maintenance.md)。

v0.5 新增：Agent 截取本篇真实运行记录并归档；配图资源箱按文章列出图位，
可复制完整提示词、在默认浏览器打开 TapNow，手动生图后导入并选用。
图片说明和标签可编辑、检索，图位可推荐已有资源；独立视觉模型支持真实识图与配色分析。

历史说明：[v0.5 截图、TapNow 与视觉资产](docs/v0.5-visual-assets.md)。

v0.4 新增：读取历史标题、正文与下期预告拟题；3–5 个候选可采用、修改、确认；
期号按当前公众号、当前栏目的真实发布记录自动加一。新增「发布记录与历史」页面，
可逐篇登记发布状态，也可先设置已有发布进度。确认后的标题进入审核记录并用于写作。

历史版本说明：[v0.4 历史拟题与发布进度](docs/v0.4-history-planning.md)。

v0.3 新增：多公众号档案与配置导入导出、新文章 AI 自动填充、草稿箱、配图资源箱、
真实像素主色提取、单图/多图 AI 配色建议与修改后应用。ICE Loop 保留为默认公众号，
其他公众号可设置自己的读者、栏目、语言风格、结尾、主题色与输出目录。

本轮使用与开发文档：[v0.3 多公众号、草稿与视觉资产](docs/v0.3-publication-workspaces.md)。

现已提供独立 Electron 桌面工作台：文章审核与 Markdown/手机预览、国内模型设置、
真实代码运行记录、事实核验、图片导入与候选选择、TapNow 窗口以及程序内截图。

**本机启动：双击 `start-desktop.cmd`。** 首次在其他电脑使用时运行
`powershell -ExecutionPolicy Bypass -File install-desktop.ps1`（需要 uv 和 Node.js 22.12+）。

详细操作、架构与本轮优化记录：[v0.2 桌面使用与开发说明](docs/v0.2-desktop-guide.md)。

先点「体验离线示例」了解完整流程；正式写作先配置 Key 和控制台可用的模型 ID。

面向 ICE Loop 公众号的文章生产 Agent 引擎。按《ICE-Loop-Agent-开发设计文档》v1.1 实现，
覆盖写作流水线、国内模型适配、规则引擎、代码真实验证、外部操作账本与文章包导出。

## 一句话

分析历史并修改确认需求 → 审核骨架 / 最终标题 / 配图计划 → 收到符合当前公众号
规范的完整文章文件夹（00-03 + code/ + images/），其中所有演示代码真实执行、
输出可追溯到 RunRecord。

## 设计原则（继承自设计文档）

1. **写作审核门不可被模型跳过**（topic / outline / final_title）。桌面新建表单的显式确认
   写入同一选题审核记录；之后继续等待骨架和配图确认。大纲/自拟标题在新建时已人工确认，
   最终标题沿用这条决定，AI 模式继续保留最终标题审核。
2. **正文运行输出只来自 RunRecord**：`<!--RUN_OUTPUT:run-N-->` 占位符由
   `integrate_evidence` 用真实执行结果回填，模型不代写输出。
3. **外部副作用走操作账本**：生图提交按 `operation_key` 幂等，`sending/unknown`
   状态先对账、禁止盲目重发；预算按候选次数预留，unknown 不释放。
4. **轻量 Python 引擎**：模型和工作流使用标准库，图片解码校验依赖 Pillow。
   离线示例显式使用 Mock；正式通道只回退到配置的真实模型。
5. **引擎凭据从环境变量读取**（`DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` /
   `MOONSHOT_API_KEY` / `BIGMODEL_API_KEY` / `ARK_API_KEY`）。桌面 Key 由 Electron
   safeStorage 加密后存储，只在主进程中解密并传给引擎，不返回给页面。
6. **不落 C 盘**：演示代码沙箱、runtime、导出目录都在数据盘（项目铁律）。

## 快速开始

```bash
cd ice-loop-agent

# 1. 自检（Python/JDK/凭据存在性）
python -m ice_agent doctor

# 2. 离线端到端 demo（Mock 写作 + 真实代码执行 + 四个审核门 + 草稿包导出）
python -m ice_agent demo --fresh

# 3. 真实模型任务（先配 Key：qwen→DASHSCOPE_API_KEY，deepseek→DEEPSEEK_API_KEY）
python -m ice_agent run --series PY --episode 5 \
    --topic "for 和 while：让电脑替你重复干活" \
    --provider qwen-deepseek --allow-local-exec \
    --prev-exercise "PY/004 动手题：车票判定" \
    --next-preview "PY/006 列表"

# 4. 审核门：任务停在 awaiting_approval 后
python -m ice_agent status --job <job-id>          # 查看待审核 payload
python -m ice_agent approve --job <job-id> --decision approve [--choice 1]

# 5. 补图闭环：demo 产出草稿包后，手动截图/生图导入 → 复检 → 就绪包
python -m ice_agent import-asset --job <job-id> --figure 2 --file 截图.png
python -m ice_agent finalize --job <job-id>        # readiness → ready_for_publish

# 6. 其他命令
python -m ice_agent articles
python -m ice_agent events --job <job-id>
python -m ice_agent reconcile --op <op-id> --decision unresolved --evidence "..."
```

## 工作流（14 节点，§8.1）

```
ingest → topic ⛔ → research → outline ⛔ → draft → verify_code(真实执行)
→ integrate_evidence(输出回填) → article_review(规则+模型，受限自动修订)
→ style_review(L1-L4 适配) → title_workshop ⛔ → asset_plan ⛔ → assets(账本)
→ final_check → export(00-03 草稿包/就绪包)
```

⛔ = 人工审核门（决定与内容 hash 绑定；`--auto-approve` 预批准模式走同一条
决定路径并记录决定者，不是隐藏跳过）。

## 模块地图

| 模块 | 职责 | 对应设计文档 |
|---|---|---|
| `ice_agent/rules/` | Markdown AST、结构/品牌/事实三层规则 | §3.2 / §2.2 / §10 |
| `ice_agent/llm/` | OpenAI 兼容传输、Qwen/DeepSeek/Kimi/GLM/Ark 适配、能力注册、角色路由与回退 | §9 |
| `ice_agent/execution/` | argv 执行、stdin 事件、超时、RunRecord、危险扫描 | §14 |
| `ice_agent/ledger/` | operation_key 幂等、发送租约、预算、三决策对账 | §13 |
| `ice_agent/workflow/` | 14 节点状态机、审核门、步骤复用、事件流 | §8 / §17.3 |
| `ice_agent/export/` | 00-03 文件契约、编号预留、原子写入、冲突守卫 | §21 / §17.4 |
| `ice_agent/providers/` | TapNow 三通道（手动导入可用；浏览器/MCP 按 §11/§12 待真实登录后启用） | §4 / §11 / §12 |
| `ice_agent/genprompt.py` | 英文一段式七要素生图提示词组装 | §16.2 |
| `ice_agent/server.py` | 可选 FastAPI 本地服务（未安装时给出明确提示） | §18 |

## 规则引擎要点（ICE Loop 适配裁定）

- 结构：唯一 `#` → `## 一、二、` → `### 1.` → `#### ①`；开头段无小标题；
  固定结尾 `## 写在最后`；文末三件套 + 品牌句 `**可执行的想象，从XX开始。**`。
- 代码：每篇 1-3 块、单块 ≤20 行、2-4 行关键注释；```` ```text ```` 运行输出块
  不占演示代码配额。
- 品牌红线：保姆级/全网最强/颠覆/史诗级等零命中；破折号 0 处；西文弯引号禁用
  （一律「」）；情绪标点（。。。/？？？）禁用；「不是X，是Y」≤1 次；
  一句话独立成段 ≥3 处。
- khazix-writer L1 适配：禁冒号不适用（品牌句式带冒号），情绪标点不适用
  （冷静人格），L1 禁用词全部保留。
- 发布边界：私有仓库链接、固定更新日承诺、无依据时长承诺、未就绪资料钩子全部阻断；
  WK 工具类文章零价格零额度数字，需「以官网为准」。
- 高风险字段（版本/价格/额度/模型名/性能倍数）必须有已核验断言，否则阻断就绪导出
  （草稿不受阻）。

## 模型接入（§9.5-§9.10）

预置五家国内平台 + 离线 Mock（能力快照日期 2026-10-01，来自官方文档，
`documented ≠ verified`，未做账号级实测）：

| 平台 | base_url | Key 环境变量 | 思考参数 |
|---|---|---|---|
| 阿里云百炼/Qwen | dashscope compatible-mode | `DASHSCOPE_API_KEY` | `enable_thinking` |
| DeepSeek 原厂 | api.deepseek.com | `DEEPSEEK_API_KEY` | `thinking.type` |
| Moonshot/Kimi | api.moonshot.cn/v1 | `MOONSHOT_API_KEY` | 未核验（unknown） |
| 智谱 BigModel | open.bigmodel.cn | `BIGMODEL_API_KEY` | GLM-5.3 不可关闭（always_on） |
| 火山方舟 | ark.cn-beijing.volces.com | `ARK_API_KEY` | 未核验 |

硬约束：`required_off` 路由会过滤 always_on / unknown 思考能力的模型，
无合格候选时返回 `MODEL_CAPABILITY_MISMATCH`，禁止悄悄降级为 `prefer_off`。
回退生成完整新候选，不与旧候选拼接；用量缺失记 `usage_unknown`，不记为零。

## 测试

```bash
python -m unittest discover -v
cd desktop
node --test tests/markdown.test.cjs
node tests/desktop-smoke.cjs
```

覆盖：规则引擎（好文通过 + 每类违规阻断）、账本幂等/预算/三决策对账、
执行器（真实运行/stdin/超时/危险扫描/双确认/Java）、思考参数翻译与
required_off 回退、结构化修复、工作流端到端（审核门暂停恢复、真实执行、
导出契约、事件序列、导出冲突守卫）、补图闭环（导入→复检→就绪包/部分导入
保持草稿）。

## 诚实边界（未宣称完成的部分）

- TapNow 浏览器/MCP 自动生图未实现：需要用户在 app.tapnow.media 完成首次
  登录与选择器验证（设计文档 M0），当前版本提供手动导入通道与账本登记。
- 国内模型适配层经过 FakeTransport 合同测试，未做账号级真实调用验收
  （无 Key 时不得宣称已实测通过，§22.4）。
- Electron 工作台与当前程序窗口截图已实现。容器隔离执行、TapNow 自动生图、
  微信发布与签名安装包仍属于后续工作。当前代码执行使用人工审阅后的本机模式。

## 目录约定

- `.demo-runtime/` `.demo-articles/`：demo 沙箱（不入库）
- `.test-tmp/`：测试沙箱（不入库）
- 桌面：`.desktop-runtime/` 保存数据库、加密凭据、截图及运行记录；
  `.desktop-articles/` 保存新文章包。已有 `output/文章` 在存稿页只读打开。
- CLI 默认使用 `.demo-articles/` 与 `.demo-runtime/`；可通过
  `--article-root` / `--runtime-root` 指向数据盘的其他目录。
