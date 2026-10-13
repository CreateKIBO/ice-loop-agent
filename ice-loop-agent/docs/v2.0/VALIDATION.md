# v2.0 验证记录（VALIDATION）

格式：命令 → 环境 → 结果（exit/统计）→ 日志路径。只记录本轮实际执行。

## V-001 Node 基线（M0-03）

- 命令：`cd desktop && E:/Node/node.exe --test tests/*.test.cjs`
- 环境：Node v24.14.1，Windows 11，G 盘项目目录
- 结果：exit 0；tests 62 / pass 62 / fail 0（与 v1.5.3 存档 62 项数量一致）
- 日期：2026-10-07
- 日志：.test-tmp/v2-run001/node-baseline.log

## V-002 Python 全量基线（M0-03，最终记录）

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest discover -s tests -t . -v`
- 环境：Python 3.12.13（项目 venv），PYTHONUTF8=1，Windows 11，G 盘项目目录
- 结果：**exit 0；Ran 383 tests / OK（0 失败 0 错误），1407.5s**（含 v2.0 新增 46 项与全部 v1.5.3 回归）
- Round2（M3 完成后，392 项）：1714s，1 项环境抖动（KI-011，隔离/复跑/换序均通过），其余全绿；日志 python-full-round2.log
- **Round3（M4 第一版，410 项）：1 错误 = KI-001 修复方向错误的回归（改错了 v1.5.3 已定义的 10000 probe 语义），当天修正**
- **Round4（最终，410 项）：exit 0；OK（1201s）**——含全部 v1.5.3 回归与 v2.0 新增 92 项；日志 python-full-round4.log
- **Round5（M5 完成后，425 项）：exit 0；OK（1311.6s）**——含全部 v1.5.3 回归与 v2.0 新增 107 项；日志 python-full-round5.log
- Round8（M7/M8-03 后，447 项）：2 失败均为测试自身问题（摘要测试 send 竞态、索引阈值过紧），已修
- Round9（447 项）：exit 0；OK（1688.7s）
- **Round10（M8 收口+M9-02/03，460 项）：exit 0；OK（1483.7s）**——含全部 v1.5.3 回归与 v2.0 新增 138 项；日志 python-full-round10.log
- 离线 eval：`python -m ice_agent.eval` exit 0（7 样例）

## V-016 发行验收（M9-06/07/08/10）

- 打包：build-release.ps1 全流水线（组件 → 新 UI Vite → PyInstaller 冻结+pydantic → 资源 → electron-builder NSIS+ZIP → 双审计）exit 0；三轮修复记录于 RELEASE_AUDIT.md
- EXE 原生 smoke（ICE_PACKAGED_EXE / win-unpacked）：
  - ui-smoke ok=true（真 asar 内 ice://app/ui/index.html 挂载）
  - chat-smoke exit 0（85 项写作旅程）
  - prompt-smoke exit 0（32 项提示词工坊）
  - dpi-smoke 150% 屏 4 档 zoom 全部 overflowX=false，几何+截图落盘 .test-tmp/v2-run001/dpi-packaged/
- 同源：verify_release 双审计通过（ZIP/Setup/unpacked 三方一致 + 引擎为最新冻结 + 无用户数据）；asar 含 ui/dist（build/check-asar-ui.cjs → ASAR_UI_OK）
- SHA256：Setup.exe = 7db80b1770afb74621bc9e6bd0f3b3bb145c420543e4342c04d7974a38e3ef9b（194,933,884 B）；x64.zip = 1285df16375334a26418193e29fd80a7443bce0b17f1fc334a3dfbc49ad2e32f（194,501,735 B）
- 隔离演练：installer/stop-agent.ps1 -DiscoverOnly（本轮无残留进程，边界正确不误杀）；ZIP 解压 854 文件至 .test-tmp/v2-run001/isolated-unpack/，主 EXE/app.asar/引擎三方 hash MATCH
- 日期：2026-10-08
- 说明：第1–3次运行为执行环境问题中断（KI-007/008/009，非代码失败；其中一次暴露迁移框架降级场景 bug 并已修复）；第4次独占运行为 round1 最终记录
- 日期：2026-10-07
- 日志：.test-tmp/v2-run001/python-baseline4.log、python-full-round2.log

## V-006 新工作台原生冒烟（M2-01，Electron 实机）

- 命令：`cd desktop && npm run smoke:ui`（= node tests/ui-smoke.cjs，spawn electron -- --ui-smoke）
- 环境：Electron 44.5.1 源码模式，全新 .test-tmp/ui-smoke-1791324145468 runtime，引擎=venv Python
- 结果：**ok=true**。ice://app/ui/index.html 挂载成功；bootstrap 返回真实账号（ICE Loop）；chat.list 与 jobs.list 真实 RPC 渲染空态；错误边界/加载态工作
- 过程修复（各回归已验证）：①契约 RpcRequest.id 拒绝 main.cjs 整数 id → 全部响应 id=null 匹配失败 → 135s 超时（根因，已修 int|str）；②assertSender 仅认旧页 URL（已扩白名单两页面）；③smoke 启动错误弹窗阻塞（已改错误文件）
- 日期：2026-10-07
- 日志：.test-tmp/v2-run001/ui-smoke-console*.log、结果 JSON 在各 ui-smoke-* runtime 目录

## V-007 Node 套件（M0-03/M2-01）

- 命令：`cd desktop && E:/Node/node.exe --test tests/*.test.cjs`
- 结果：exit 0；tests 76 / pass 76 / fail 0（62 项 v1.5.3 + 14 项 ui-contracts）
- 日期：2026-10-07

## V-008 旧页回归冒烟（main.cjs 修改后）

- 命令：`cd desktop && node tests/desktop-smoke.cjs`（--smoke 全量旧 UI 旅程）
- 结果：**exit 0**；desktop-smoke.json 断言全过（connected/previewEscaped/completed/exported/runs=3/gates/modelCards=6/evidenceCards=3/compact 布局等），20 张页面截图落盘
- 运行目录：.test-tmp/electron-1791324257922/
- 结论：main.cjs 的协议路由/--ui-smoke/白名单/错误码改动对旧 renderer 无回归
- 日期：2026-10-07

## V-009 Markdown 桥与共享 fixture（M3-02）

- 命令：`cd desktop && node --test tests/editor-markdown.test.cjs`
- 结果：5/5 通过（块类型序列、字节 round-trip、编辑后幂等、HTML raw 保留、图位/运行引用字段）
- fixture：tests/fixtures/editorial-sample.md（Python/Node 共用；Python 侧断言在 tests/test_v2_editor.py）
- 日期：2026-10-07

## V-010 新工作台冒烟（编辑器打包后复验）

- 命令：`cd desktop && npm run smoke:ui`
- 结果：ok=true；ice://app/ui/index.html 挂载，编辑器/CodeMirror/motion 全量 bundle 下真实引擎数据渲染正常
- 日期：2026-10-07

## V-011 跨 DPI 几何冒烟（M2-10）

- 命令：`cd desktop && npm run smoke:dpi`
- 结果：4 档 zoomFactor（1/1.25/1.5/2）全部 overflowX=false；dpi-geometry.json + 4 张截图落盘（.test-tmp/dpi-smoke-*）
- 日期：2026-10-07

## V-012 M4 知识检索与评测

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest tests.test_v2_knowledge tests.test_v2_knowledge_eval`
- 结果：**18/18 通过**（导入幂等/分块/3字与1-2字搜索/FTS不可用降级/账号隔离/增量重建可续/ContextPack 分层与截断与花括号/注入资料不升格指令/220 标题覆盖/不足五篇/下期+1+同期草稿/KI-001 边界/重复选题解释/12 栏目×200 题/冲突需显式覆盖）
- 性能实测（1008 篇合成文章、3024 分块、3 账号）：索引 56.5s；长查询 P95=3.09ms P50=0.78ms；1-2字查询 P95=1.07ms；misses=0。数据：.test-tmp/v2-keval-*/knowledge-eval.json
- UI 冒烟复验：ok=true，知识检索面板与导入按钮在真实应用渲染
- 日期：2026-10-07

## V-013 M5 受限编辑 Agent

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest tests.test_v2_agent`
- 结果：**15/15 通过**
- 覆盖：注册表契约（18 工具/action 白名单/超时上限）、未知工具（execute_shell/approve_execution）拒绝、原生 tool_calls 与 ActionEnvelope 双路径、畸形信封 parse_error 不执行、正文 JSON 不误判、循环持久化、6轮/12次上限触达、熔断（同失败2次停）、取消置 cancelled、search/brief/question/幂等任务走真实服务、问题回答不可覆盖、brief 来源字段分离、注入资料不产生调用、账号域读取拒绝
- UI：AgentActionCards 行动卡上线（真实记录渲染）；TSC/构建/Node 81/81/ui-smoke ok=true
- 日期：2026-10-07

## V-014 M5-06 收口与 M6 核心

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest tests.test_v2_chat_loop tests.test_v2_agent tests.test_v2_workflow_review`
- 结果：**33/33 通过**（chat 信封→工具循环真实执行+行动卡读取、普通回复零 run、取消终态；循环重复守卫/上限/熔断/取消；IR 接入与回退；失效映射五组；批量计划；审阅聚合五节+账号隔离；会话摘要确定性+更新+隔离）
- 全量 round6：**440/440 exit 0**（python-full-round6.log）
- 关键设计：循环新增 model_repeated_calls 停止语义（整轮重复已成功的相同调用集收口；失败轮走熔断、取消优先于重复判定）——由固定回复夹具暴露的真实空转缺陷
- 日期：2026-10-07

## V-015 M7 核心与 M8-03（第六轮）

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest tests.test_v2_assets_budget tests.test_v2_migrations`
- 结果：13/13 通过（StylePack 版本/批准、七要素 lint 完整/缺项/期号残留/实截警告、提示词版本 origin 区分、图位-Run 绑定 hash 校验+预期错误批准、下载 magic/去重/绑定/丢弃、会话调用归属+预算入口拦截、迁移框架回归）
- UI：WorkflowGraph React Flow 投影上线；tsc+构建+ui-smoke ok=true；Node 81/81
- 修复：迁移 v16 少闭合括号（KI-013）、promptv RPC 撞车改名（KI-012）
- 日期：2026-10-08

## V-005 v2.0 新增测试汇总（第二轮更新）

| 测试文件 | 项数 | 结果 |
|---|---|---|
| tests/test_v2_migrations.py | 6 | 全部通过 |
| tests/test_v2_contracts.py | 7 | 全部通过 |
| tests/test_v2_protocol.py | 7 | 全部通过 |
| tests/test_v2_events.py | 5 | 全部通过 |
| tests/test_v2_task_queue.py | 10 | 全部通过 |
| tests/test_v2_dispatch.py | 2 | 全部通过 |
| tests/test_v2_cancel_idempotency.py | 4 | 全部通过 |
| tests/test_v2_m1_exit.py | 5 | 全部通过（含真实子进程协议） |
| tests/test_v2_editor.py | 9 | 全部通过（M3 全链：文档/草稿/提案/冲突/审批/恢复） |
| tests/test_v2_knowledge.py | 16 | 全部通过（M4 全链+12栏目×200题） |
| tests/test_v2_knowledge_eval.py | 2 | 全部通过（1008 篇性能评测） |
| tests/test_v2_agent.py | 16 | 全部通过（M5：注册表/适配/循环/熔断/取消/澄清/brief/重复守卫） |
| tests/test_v2_chat_loop.py | 3 | 全部通过（chat→AgentLoop 集成） |
| tests/test_v2_workflow_review.py | 11 | 全部通过（M6 核心+M5-08 摘要） |
| tests/test_v2_assets_budget.py | 7 | 全部通过（M7 核心+M8-03 预算归属） |
| desktop/tests/editor-markdown.test.cjs | 5 | 全部通过（前后端共享 fixture 字节往返） |
| desktop/tests/ui-contracts.test.cjs | 14 | 全部通过 |

- 日期：2026-10-08
- 说明：v2 新增 125 项与 v1.5.3 既有套件分离计数，最终统计去重后并入交付报告

## V-003 迁移框架与备份恢复（M0-04/05/08/09）

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest tests.test_v2_migrations -v`
- 结果：exit 0；6/6 通过（迁移幂等、dry-run 回滚、故障注入回滚、新库拒绝、备份运行中阻断+往返一致、恢复拒绝已存在目录/坏 hash）
- 日志：.test-tmp/v2-run001/v2-migrations-tests.log
- 日期：2026-10-07

## V-004 依赖最小实验（M0-06）

- 步骤：npm install（desktop/ui，163 包，exit 0）→ node scripts/gen-validators.mjs（Ajv standalone 代码生成）→ vite build（exit 0，616KB bundle）→ tsc --noEmit（通过）
- 离线/CSP 核验：dist 产物 grep `new Function(` 与 `eval(` 均为 false
- FTS5 探测：venv SQLite FTS5 与 trigram tokenizer 均可用（运行时再随引擎核验）
- pydantic：2.13.5 已在 venv（尚未写入 pyproject，M1-01 时正式加入）
- 说明：TypeScript 锁 5.9.3（7.0.2 刚发布未选用，降级风险；后续单独评估）；产物单 chunk>500KB 提示后续代码分割
- 日期：2026-10-07
