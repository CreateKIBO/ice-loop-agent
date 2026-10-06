# v2.0 已知问题（KNOWN_ISSUES）

格式：复现 → 根因 → 范围 → 状态。

## KI-001 publication_history.context 期号边界文案不一致（来自 04-对照 §2）

- 复现：待运行复现（构造 episode=10000 的 context 查询）。
- 根因：context 校验允许 <=10000 但错误文案写 9999。
- 范围：publication_history.py。
- 状态：未修复（M4-08 补边界检查时一并验证修复）。

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

## KI-008 同一 runtime 目录被两个引擎进程同时打开导致 bootstrap 挂起（2026-10-07）

- 复现：前次被终止的冒烟留下未退出的引擎进程，再次启动同 runtime 的冒烟时 bootstrap 无响应直到 135s 超时。
- 根因：main.cjs 无单实例锁；引擎侧也无同库互斥（SQLite WAL 允许多连接，但两个 main() 引擎竞争导致握手异常）。自动化终止 shell 未级联终止引擎子进程。
- 范围：desktop/main.cjs startEngine、测试流程卫生。
- 状态：规避（测试前清理本项目引擎进程、每次冒烟用全新 runtime 目录）；正式修复（引擎互斥/单实例锁）列入 M2-10 生命周期检查。

## KI-009 后台任务终止会连带终止同控制台的其他后台任务（执行环境观察，2026-10-07）

- 复现：TaskStop 一个后台 shell 时，另一个正在跑全量 unittest 的后台 shell 同时收到终止（日志尾部 EXIT=127）。
- 根因：执行平台的后台任务共享控制台会话，终止为进程组级。
- 范围：本轮执行环境，不是产品代码问题。
- 状态：规避——全量测试独占运行，期间不启动/停止其他后台任务。
