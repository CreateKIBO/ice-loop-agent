# v2.0 已知问题（KNOWN_ISSUES）

格式：复现 → 根因 → 范围 → 状态。

## KI-001 publication_history.context 期号边界文案不一致（来自 04-对照 §2）

- 复现：✅ 已复现并澄清（2026-10-07）。真实语义：context 的 target 是"参考期号"，发布进度打满 9999 后为 10000（此时 next_episode=None，v1.5.3 测试 test_history_limits_and_date_validation 明确要求 progress(9999) 成功）；不一致的只是错误文案。
- 修复：保留 probe 语义与 <=10000 检查，文案改为"期号需为1–9999（全部发布完后下一期建议为空）"；新增回归（progress 9999→next None、progress 10000 拒绝、context(10000) 合法）。
- 状态：已修复（文案与语义对齐，未改变 v1.5.3 行为）。

## KI-002 创作讨论请求不计入制作任务预算

- 复现：notes.md 核对 v1.5.2 进度文档。
- 根因：model_invocations 以 job_id 为预算归属，chat 调用无 job。
- 范围：creative_chat.py、store.reserve_invocation。
- 状态：M8-03 统一 invocation 归属时修复。

## KI-003 自动截图准备队列 attempted 集合仅内存

- 复现：automation.cjs PreparationQueue 注释。
- 根因：无持久化队列。
- 范围：desktop/automation.cjs。
- 状态：M1-06/M7-06 持久队列与图位-run 精确映射时修复。

## KI-004 electron-builder files 白名单未覆盖 ui/ 与 main-services/

- 复现：desktop/electron-builder.json。
- 根因：白名单编写于新目录产生之前。
- 范围：打包。
- 状态：M9-06 更新构建脚本时修复。
- 复核（2026-11-05，第24轮）：当前 `desktop/electron-builder.json` 的 files 已含 `ui/dist/**/*`；仓库中不存在 `main-services/` 目录，主进程模块均为 desktop 根目录下逐个列出的 `.cjs`。白名单缺口按源码判断已关闭；真机打包内容尚未在本轮复验，复验时以 `build/check-asar-ui.cjs` 结果为准。

## KI-005 Ctrl+K 为本地记录搜索，非段落级检索

- 状态：设计现状，非 bug；M4-05 新增正文检索时并存。

## KI-006 渲染器轮询式读取创作流式回调

- 状态：设计现状；M1-05 事件流升级后新 UI 用订阅，旧页保留轮询（过渡期允许，不双通道）。

（新问题按编号追加）

## KI-007 启动失败走 showErrorBox 会阻塞自动化运行（2026-10-07）

- 复现：ui-smoke 冒烟中引擎启动失败时，main.cjs 走 dialog.showErrorBox 等待人工点击，自动化进程挂起。
- 根因：catch 分支只对 --smoke/--review-smoke/--provider-smoke 写错误文件，--ui-smoke 落入弹窗分支。
- 范围：desktop/main.cjs 启动错误处理。
- 状态：已修复（ui-smoke 也写错误文件+退出）。

## KI-008 冒烟 bootstrap 全部 135s 超时（根因：契约拒绝整数请求 id）（2026-10-07，已修复）

- 复现：ui-smoke 中 main.cjs 以自增整数作 JSON Lines 请求 id；v2 契约 RpcRequest.id: str 校验拒绝 → 响应 id=null → 主进程 pending 永不匹配 → 135s 超时。
- 根因：v1 主进程从未约束 id 类型，v2 契约过严且破坏兼容（违反"旧客户端形状保持"原则）。
- 修复：RpcRequest/RpcResponse.id 改为 str|int|None，响应原样回显（tests/test_v2_protocol.py 补形状断言；schema 已重导出）。
- 次要因素：被终止冒烟残留引擎进程占用新 runtime（自动化终止 shell 不级联终止引擎）——测试流程卫生规避；引擎单实例锁列入 M2-10。

## KI-010 assertSender 白名单不认新页面 URL（2026-10-07，已修复）

- 复现：新 UI 加载后全部 IPC 被拒（"无效的窗口请求"）。
- 修复：TRUSTED_APP_FRAMES 白名单含 ice://app/index.html 与 ice://app/ui/index.html，安全边界未弱化（仍限同 window 同 webContents）。

## KI-012 新 RPC 与既有方法名撞车（2026-10-08，已修复）

- 复现：application 层新注册 `prompts.save/lint`，与 v1.5.3 workbench.METHODS 的 `prompts.save` 冲突；application dispatch 先命中导致旧 PromptWorkbench 合同破坏（test_image_prompts 失败）。
- 修复：新 RPC 改名 `promptv.*`（版本化提示词域）；教训：新增 RPC 前必须 grep 全部 METHODS/dispatch 表。
- 状态：已修复（round8 全量验证）。

## KI-013 迁移字符串少闭合括号导致 incomplete input（2026-10-08，已修复）

- 复现：v16 两条 CREATE TABLE 的 `UNIQUE(...)` 后少一个 `)`（把 SQL 收尾括号写成 Python 调用括号），运行时 sqlite3.OperationalError: incomplete input。
- 修复：补括号；教训：多行 SQL 字符串的收尾 `)` 必须在字符串内。逐条 AST 重放定位（tests 外的诊断脚本模式）。
- 状态：已修复。

## KI-011 全量 discover 偶发 demo 任务 'failed' 抖动（2026-10-07，观察项）

- 复现：392 项全量 discover 中 tests.test_workflow.TestReadinessLoop.test_import_rejects_non_image 一次 'failed' != 'completed'；隔离运行、test_workflow+test_v2_editor 两种顺序组合、复跑均通过。
- 根因：待查（疑似 G 盘高负载下 demo 工作流某节点的瞬时资源竞争）。当前断言只看 state，未保留引擎错误详情。
- 范围：测试基建可观测性，不是产品代码回归（round1 383/383 与随后复跑均绿）。
- 状态：未修复。跟进：为 _complete_draft 断言失败时输出 job 错误详情（改进测试诊断，不改变断言语义）；若再现按错误分类归因。

## KI-009 后台任务终止会连带终止同控制台的其他后台任务（执行环境观察，2026-10-07）

- 复现：TaskStop 一个后台 shell 时，另一个正在跑全量 unittest 的后台 shell 同时收到终止（日志尾部 EXIT=127）。
- 根因：执行平台的后台任务共享控制台会话，终止为进程组级。
- 范围：本轮执行环境，不是产品代码问题。
- 状态：规避——全量测试独占运行，期间不启动/停止其他后台任务。
