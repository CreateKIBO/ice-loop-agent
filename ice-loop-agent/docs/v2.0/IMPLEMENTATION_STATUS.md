# v2.0 实施状态（IMPLEMENTATION_STATUS）

run_id: v2-run001。每项按矩阵模板记录；"通过"仅来自实际执行。状态：未开始/进行中/完成/阻塞。

## M0 基线、兼容与恢复

- M0-01 基线版本与工作区地图 — **完成**。实现：docs/v2.0/BASELINE.md。验收：版本/Git/边界已核对（2026-10-07 实读源码）。限制：用户 E 盘真实工作区本轮只读。
- M0-02 RPC与领域对象审计 — **完成**。实现：BASELINE.md「RPC方法清单」。全部 dispatch 入口已定位，无未知项。
- M0-03 v1.5.3回归基线重跑 — **进行中**。Node 62/62 passed（V-001）。Python 套件运行中，结果待记入 V-002。
- M0-04 数据库迁移样本 — **完成**。实现：tests/test_v2_migrations.py（v9 形态样本库+完整 Store schema 工作负载；坏 hash/已占用目录拒绝）。证据 V-003。
- M0-05 一致备份与恢复演练 — **完成**。实现：复用 backup.py（sqlite backup API+integrity_check+hash 绑定）；测试覆盖运行中阻断、往返一致、路径重映射、hash 校验。证据 V-003。
- M0-06 依赖最小实验与许可登记 — **完成**。实现：desktop/ui（React19/Tiptap3.31/Ajv8 standalone/Vite8/TS5.9）；gen-validators.mjs 预编译校验器；dist 无 eval。许可与版本：DEPENDENCIES.md。证据 V-004。
- M0-07 架构决定和兼容策略 — **完成（初版）**。docs/v2.0/DECISIONS.md ADR-001…012；依赖实验后补充锁定版本。
- M0-08 编写编号迁移框架 — **完成**。实现：ice_agent/migrations/（编号+checksum+事务+dry-run+故障注入参数）；首个迁移 v10=stream_events。证据 V-003（幂等/dry-run/回滚测试）。
- M0-09 升级保护与故障注入 — **完成**。实现：run_migrations(stop_after=) 故障注入；测试断言 user_version 回退、schema 回退、数据可读、Store 拒绝更新库。证据 V-003。
- M0-10 M0出口与后续计划 — 未开始

## M1 契约、事件与可靠任务

- M1-01 权威请求/响应模型 — **完成**。实现：ice_agent/contracts/（Pydantic 信封+chat.send+delta 载荷，ErrorCode 枚举）；build/export_contracts.py 导出 6 份 JSON Schema 到 desktop/ui/contracts/；desktop/ui/scripts/gen-ts-types.mjs 生成 TS 投影、gen-validators.mjs 生成预编译 Ajv（无 eval）。验收：tests/test_v2_contracts.py 7 项通过（含漂移阻断：schema 与注册表不一致即 FAIL）。
- M1-02 协议v2兼容解析 — **完成**。实现：ice_agent/rpc_channel.py（RpcChannel：kind=response/event 帧、非法行容错不中断、legacy 领域错误码映射表、线程安全写）；desktop_service.main() 接入（空行跳过、stdout 纯协议）。验收：tests/test_v2_protocol.py 7 项通过（v1 客户端 id/result 形状保持、坏 JSON/非对象行回 VALIDATION_ERROR、并发写整行）。
- M1-03 应用服务模块提取 — **完成（首增量）**。实现：ice_agent/application/（Handler 注册表 + EventsHandler 首组迁移）；DesktopService.call 门面保留，application 层未命中再走原模块链。账号校验保持在 handler 委托的原方法内，未因拆分丢失。后续 groups（articles/assets/settings）随对应阶段需求按同一模式增量迁移。
- M1-04 有限并发与连接协调 — **完成（核心）**。实现：RpcChannel executor/route 支持；desktop_service.HEAVY_METHODS（模型调用/执行/备份等 16 方法）池内串行，stdin 读循环不阻塞。验收：tests/test_v2_dispatch.py 2 项通过（重操作占线时轻查询<2s 响应；重操作串行保持 v1.5.3 语义）。
- M1-05 持久事件和游标回放 — **完成（核心）**。实现：迁移 v10 stream_events 表；Store.append_stream_event/stream_events_after/latest_stream_sequence（BEGIN IMMEDIATE 内单调 sequence）；ice_agent/events.py EventBroker（delta 80ms/400字符批量合并、flush）；RPC events.poll/events.latest（账号校验）。验收：tests/test_v2_events.py 5 项通过（并发 40 事件 sequence 连续无重复、游标幂等回放、burst 合并单事件、去重与缺口检测）。
- M1-06 持久队列与租约 — **完成（核心）**。实现：迁移 v11 tasks 表；ice_agent/tasks/ TaskQueue（优先级认领单租约、心跳、attempt 上限重试、queued 立即取消/running 记 cancel_requested 协作确认、晚到结果按 token 拒写、requeue_expired 恢复、idempotency_key 幂等）。验收：tests/test_v2_task_queue.py 10 项通过。
- M1-07 端到端取消 — **完成**。实现：TaskQueue.cancel/confirm_cancelled（queued 立即/running 记请求协作确认）；v1.5.3 chat.stop 取消令牌链保留（stop 返回"远端请求可能仍产生费用"）。验收：tests/test_v2_cancel_idempotency.py::test_stop_then_late_finish（取消后晚到结果拒写、状态停留 cancelled）；既有 test_creative_chat.py::test_stop_discards_late_reply_and_can_continue（全量基线覆盖）。
- M1-08 幂等与未知副作用恢复 — **完成**。实现：TaskQueue idempotency_key 唯一；chat.create request_id+request_hash 去重（同 key 异输入显式拒绝）；OperationsLedger sending/unknown/needs_reconciliation 对账链保留。验收：tests/test_v2_cancel_idempotency.py 4 项通过（入队幂等、创建去重、unknown 不重提交、取消后晚到结果拒写）；既有 test_ledger.py 全量基线覆盖。
- M1-09 类型错误与可恢复响应 — **完成（核心）**。实现：契约 ErrorCode 13 类 + recoverable/action 字段；rpc_channel.error_code_for（ProtocolError → legacy 领域码映射 → ValueError/Permission/Network 兜底）；错误响应不回显 params。验收：test_v2_protocol.py（错误映射、不回显参数）；test_v2_contracts.py（错误合同）。
- M1-10 M1并发与恢复验收 — **完成**。实现：tests/test_v2_m1_exit.py（真实子进程协议集成：v1 形状兼容+kind 字段、坏行恢复、轻查询进程级响应；僵尸租约恢复清零；快速重复入队折叠）。验收：5/5 通过。全量基线（v1.5.3 套件）第4次独占重跑结果见 VALIDATION V-002。

## M2 工作台、设计系统与交互

- M2-01 新renderer基础与桥接 — 未开始
- M2-02 品牌token和公共控件 — 未开始
- M2-03 三栏及专注布局 — 未开始
- M2-04 导航与对象路由 — 未开始
- M2-05 账户隔离异步数据层 — 未开始
- M2-06 未保存输入与恢复 — 未开始
- M2-07 真实进度与行动组件 — 未开始
- M2-08 Motion动效与偏好 — 未开始
- M2-09 键盘、中文IME与焦点 — 未开始
- M2-10 M2跨DPI及旧页回归 — 未开始

## M3 统一编辑器、Patch与版本

- M3-01 ArticleDocument与版本关联 — 未开始
- M3-02 Tiptap双模式编辑器 — 未开始
- M3-03 稳定图位节点 — 未开始
- M3-04 真实保存与恢复草稿 — 未开始
- M3-05 选段上下文与Patch模型 — 未开始
- M3-06 逐项对比与采纳 — 未开始
- M3-07 三方冲突与安全重基 — 未开始
- M3-08 版本历史及恢复到新版本 — 未开始
- M3-09 审批同步版本锁定 — 未开始
- M3-10 M3编辑器旅程验收 — 未开始

## M4 知识检索、ContextPack与选题

- M4-01 导入服务与来源模型 — 未开始
- M4-02 段落/章节切块与引用定位 — 未开始
- M4-03 FTS5探测与中文索引 — 未开始
- M4-04 索引增量更新及恢复 — 未开始
- M4-05 全文搜索与引用UI — 未开始
- M4-06 ContextPack编排 — 未开始
- M4-07 历史拟题覆盖与解释 — 未开始
- M4-08 任意栏目排期管理 — 未开始
- M4-09 重复选题与承接关系 — 未开始
- M4-10 M4检索与规划评测 — 未开始

## M5 受限编辑Agent与对话闭环

- M5-01 工具注册表与授权等级 — 未开始
- M5-02 模型tool_calls适配 — 未开始
- M5-03 有界工具执行循环 — 未开始
- M5-04 检索与Brief工具落地 — 未开始
- M5-05 起草和选段改稿工具 — 未开始
- M5-06 行动卡与流式对话 — 未开始
- M5-07 澄清问题持久续接 — 未开始
- M5-08 会话记忆与摘要版本 — 未开始
- M5-09 Agent到工作流与资源工具 — 未开始
- M5-10 M5安全与完整对话旅程 — 未开始

## M6 工作流编排、最小重跑与审阅

- M6-01 节点合同与输出验证 — 未开始
- M6-02 依赖失效与最小重跑 — 未开始
- M6-03 自动准备与逐步模式统一 — 未开始
- M6-04 多期批量队列 — 未开始
- M6-05 工作流图与受限模板 — 未开始
- M6-06 统一审阅中心 — 未开始
- M6-07 事实与规则定位 — 未开始
- M6-08 任务可见性与删除恢复 — 未开始
- M6-09 审阅变更与依赖通知 — 未开始
- M6-10 M6恢复与审阅journey — 未开始

## M7 视觉资产、提示词与内嵌浏览器

- M7-01 资产元信息与去重引用 — 未开始
- M7-02 资源库筛选与批量操作 — 未开始
- M7-03 StylePack版本与批准 — 未开始
- M7-04 提示词编译器与lint — 未开始
- M7-05 Prompt版本与候选流程 — 未开始
- M7-06 图位到Run精确映射 — 未开始
- M7-07 浏览器大空间与遮挡修复 — 未开始
- M7-08 下载待归档与图位绑定 — 未开始
- M7-09 浏览器会话与任务上下文 — 未开始
- M7-10 M7视觉与截图端到端 — 未开始

## M8 模型治理、预算、运维与容量

- M8-01 能力注册与分项探测 — 未开始
- M8-02 SSE与结构化兼容加固 — 未开始
- M8-03 统一调用归属与预算预留 — 未开始
- M8-04 预算UX与可选金额估算 — 未开始
- M8-05 质量评测样例与路由策略 — 未开始
- M8-06 结构化日志与诊断包 — 未开始
- M8-07 容量分类与安全缓存策略 — 未开始
- M8-08 本次运行与残留登记 — 未开始
- M8-09 性能与生命周期专项 — 未开始
- M8-10 M8模型与异常旅程 — 未开始

## M9 导出、升级发行与最终验收

- M9-01 发布就绪预检 — 未开始
- M9-02 MD/TXT与图片两目录导出 — 未开始
- M9-03 Manifest与提交一致性 — 未开始
- M9-04 移动端预览与发布登记 — 未开始
- M9-05 全源码检查与用户旅程 — 未开始
- M9-06 冻结依赖与同源打包 — 未开始
- M9-07 最终EXE原生验收 — 未开始
- M9-08 隔离覆盖安装与恢复演练 — 未开始
- M9-09 手册、许可、变更与维护文档 — 未开始
- M9-10 发行审计与最终交付 — 未开始
