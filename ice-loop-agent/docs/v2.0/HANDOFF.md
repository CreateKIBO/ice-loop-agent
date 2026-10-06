# v2.0 HANDOFF

更新时间：2026-10-07（run_id: v2-run001，第3次更新）

```text
当前基线/应用版本/协议/schema：
  ice_agent __version__=1.5.3（未改版本号）；契约层 PROTOCOL_VERSION=2（ice_agent/contracts）
  SQLite MAX_KNOWN_VERSION=11（v10=stream_events、v11=tasks；迁移框架 ice_agent/migrations 自动应用并记 schema_migrations）
  desktop/ui：React19+Vite8+TS5.9+Tiptap3.31+Radix+TanStack Query/Virtual+Ajv8+DOMPurify+Zustand+ReactFlow（版本锁定见 DEPENDENCIES.md）
当前阶段和最近完成任务：
  M0 全部完成（M0-10 汇总材料待最后补一节）。M1 全部 10 项完成（M1-03 为首增量：application/ 提取层+EventsHandler）。
  M2 进行中：M2-01 已实现（ice:// 协议服务 ui/dist、--new-ui 开关、--ui-smoke 冒烟入口、CSP meta、错误边界）；
  M2-02 tokens+控件（components/ui.tsx）、M2-03 三栏壳（app/WorkbenchShell.tsx）、M2-05 数据层（data/client.ts）已写码待冒烟验证。
修改文件与关键入口：
  后端：ice_agent/{contracts,rpc_channel,events,tasks,migrations,application}（新）；domain/store.py（迁移接入+stream_events 方法）；
        desktop_service.py（RpcChannel main、HEAVY_METHODS 池、events.poll/latest、application 分派）
  桌面：desktop/main.cjs（协议 /ui/ 路由、--new-ui/--ui-smoke、错误码透传、ui-smoke 错误文件化）；package.json scripts
        （build:ui/check:ui/smoke:ui/start:new-ui）；tests/ui-smoke.cjs、tests/ui-contracts.test.cjs（76/76 通过）
  UI：desktop/ui/（contracts 6 schema+生成物；src/components/ui.tsx、app/WorkbenchShell.tsx、data/client.ts、main.tsx bootstrap 接线）
  测试：tests/test_v2_*.py 8 个文件 46 项全部通过
已运行测试、结果和日志：
  - Node 76/76（tests/*.test.cjs 含 14 项新 ui-contracts）
  - Python v2 新增 46 项全过；全量基线第4次独占运行中 → .test-tmp/v2-run001/python-baseline4.log（完成即回填 V-002）
尚未验证的边界：
  - --ui-smoke 实际 Electron 运行（被进程管理问题阻塞两次，见 KI-007/008；main.cjs 已修 showErrorBox 阻塞路径）
  - 新 UI bootstrap→账号显示的人工视觉确认（截图）
活跃进程/临时目录及owner：
  baseline4 unittest discover 独占运行中；.test-tmp/v2-run001/（owner=v2-run001）+ ui-smoke-runtime{,2}（残留待清，收尾时只清本轮目录）
重要执行教训（避免重复踩坑）：
  1. 不要在后台任务运行时 TaskStop 另一个后台任务（会连带终止同控制台任务，KI-009）
  2. 冒烟前清理本项目残留引擎进程；每次冒烟用全新 runtime 目录（KI-008）
  3. main.cjs 启动错误对 smoke 类 flag 走错误文件而非弹窗（已修）
下一项任务、应读文件和具体操作：
  1) baseline4 完成后回填 VALIDATION.md V-002 + IMPLEMENTATION_STATUS M0-03
  2) 运行 npm run smoke:ui（desktop 目录）验证新 UI 挂载；截图确认视觉
  3) M2-04：左栏导航（账号切换 resetForAccountSwitch、最近会话、草稿入口、对象路由 ID）
  4) M2-06/M2-07/M2-08/M2-09 按 IMPLEMENTATION_STATUS 顺序
已知问题/必要用户输入：
  KI-001…009（docs/v2.0/KNOWN_ISSUES.md）；无阻塞性用户输入
与报告差异及批准/未批准状态：
  TypeScript 锁 5.9.3（非 7.0.2）；新 UI 以 feature flag 存在、旧页默认——均记录于 DECISIONS/DEPENDENCIES
```
