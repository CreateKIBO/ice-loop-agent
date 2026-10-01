# Content Studio / ICE Loop Agent v0.4

v0.4 新增：读取历史标题、正文与下期预告拟题；3–5 个候选可采用、修改、确认；
期号按当前公众号、当前栏目的真实发布记录自动加一。新增「发布记录与历史」页面，
可逐篇登记发布状态，也可先设置已有发布进度。确认后的标题进入审核记录并用于写作。

最新使用与开发说明：[v0.4 历史拟题与发布进度](docs/v0.4-history-planning.md)。

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
   写入同一选题审核记录；之后继续等待骨架和最终标题确认。
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
