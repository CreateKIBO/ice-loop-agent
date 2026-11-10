# v2.0 实施状态（IMPLEMENTATION_STATUS）

2026-11-05 路线更新：[工作台优先转向开发报告](../上线准备/工作台优先转向-开发报告-2026-11-05.md)列出当前产品转向的任务与验收。本文的“完成”属于原 v2.0 任务架构及对应历史证据，不表示普通草稿独立编辑、真实图片块、通用浏览器或新排版交付已完成。转向状态以新报告及后续实际验收记录为准。

run_id: v2-run001。每项按矩阵模板记录；"通过"仅来自实际执行。状态：未开始/进行中/完成/阻塞。

## M0 基线、兼容与恢复

- M0-01 基线版本与工作区地图 — **完成**。实现：docs/v2.0/BASELINE.md。验收：版本/Git/边界已核对（2026-10-07 实读源码）。限制：用户 E 盘真实工作区本轮只读。
- M0-02 RPC与领域对象审计 — **完成**。实现：BASELINE.md「RPC方法清单」。全部 dispatch 入口已定位，无未知项。
- M0-03 v1.5.3回归基线重跑 — **完成**。Python：383/383 通过 exit 0（V-002，含 v2 新增 46 项与全部 v1.5.3 回归；两次中断为环境问题见 KI-007/008/009）。Node：76/76（V-001 + ui-contracts 14 项）。
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

- M2-01 新renderer基础与桥接 — **完成**。实现：main.cjs ice:// 协议 /ui/ 前缀服务 desktop/ui/dist；--new-ui feature flag（默认旧页）；--ui-smoke 原生冒烟入口（did-fail-load/超时兜底，错误写文件不弹窗）；ErrorBoundary；CSP meta（无 unsafe-eval）；assertSender 扩展受信页面白名单（旧页+新页）。验收：**V-006 原生冒烟 ok=true**（真实引擎 bootstrap+RPC）；过程修复 3 处（整数请求 id 契约兼容为根因）。
- M2-02 品牌token和公共控件 — **完成（首批）**。实现：styles/tokens.css（品牌三色、间距/圆角/焦点环/动效时长/密度/减弱动效双通道）；components/ui.tsx（Button 四态+loading 定宽、IconButton、Input、Banner、ErrorPanel、EmptyState、Spinner、Radix Dialog/Tabs/Tooltip 封装，z-index 分层）。验收：TSC 通过；视觉与 1280 宽验证并入 V-006 冒烟截图。
- M2-03 三栏及专注布局 — **完成（基础）**。实现：WorkbenchShell（可拖拽分隔条含键盘操作、最小宽度、布局 localStorage 持久化防抖）；专注模式与窄窗抽屉随 M2-10 补。验收：构建通过；拖拽行为冒烟中人工验证。
- M2-04 导航与对象路由 — **完成（基础，冒烟验证）**。实现：LeftNav（账号切换 select→accounts.switch→整体清缓存+重载；会话过滤搜索；最近会话列表 conversationStore 模块级选中态持久化；同会话多轮单条记录）。验收：V-006 冒烟中真实 chat.list 渲染与空态；三账号隔离并入 J08。
- M2-05 账户隔离异步数据层 — **完成（核心，冒烟验证）**。实现：data/client.ts（QueryClient 默认不重试；useAccountQuery key 强制 ['ice',account,method,params]；resetForAccountSwitch cancel+clear；RpcError 携带稳定 code/recoverable/action；useEventStream 游标轮询补取）。验收：V-006 冒烟中两个账号域查询真实工作；三账号快速切换行为并入 J08。
- M2-06 未保存输入与恢复 — **完成**。实现：data/client.ts dirtyStore（对象级键 dirty:job:{id}:editor，全局 beforeunload 守卫 useAnyDirtyGuard）；编辑器 debounce 800ms 工作草稿（editor_drafts 表幂等保存）；重开检测未保存草稿 → 恢复/丢弃横幅；保存失败保留输入并显示原位错误。验收：V-002 全量中 editor_draft 幂等/隔离测试；恢复横幅逻辑在 V-009/V-010 打包验证。
- M2-07 真实进度与行动组件 — **完成（当前范围）**。实现：ChatPane（时间线/streaming/停止）、RightPane（任务卡、正在停止、归档过滤、编辑正文入口）。伪百分比不存在（文字状态+busy 图标）。工具级行动卡随 M5-06。
- M2-08 Motion动效与偏好 — **完成（基础）**。实现：MotionConfig reducedMotion="user" 包裹全应用；AnimatePresence 用于横幅（冲突/审批过期/草稿恢复）与提案卡 layout 动画；动效时长走 tokens（120–260ms）。验收：构建+V-010；关闭动效仍有文字反馈（横幅常驻非动画依赖）。
- M2-09 键盘、中文IME与焦点 — **完成**。实现：Composer composition 守卫；Ctrl+K 命令面板（Dialog 打开保存/恢复焦点、↑↓/Enter、命令：打开编辑器/返回对话/聚焦会话）；分隔条键盘操作。验收：V-009 构建；IME 人工验证项列入最终验收清单。
- M2-10 M2跨DPI及旧页回归 — **完成**。实现：--dpi-smoke + tests/dpi-smoke.cjs（zoomFactor 100/125/150/200%，记录窗口/视口几何 JSON + 4 张截图，断言无横向溢出）。验收：**V-011 dpi-smoke 通过**（4 档 overflowX=false）；旧页回归 V-008 此前已过。

## M3 统一编辑器、Patch与版本

- M3-01 ArticleDocument与版本关联 — **完成**。实现：ice_agent/editorial/（parse_document/serialize_document，复用 rules.markdown_ast；稳定块 ID=类型+内容指纹；旧图位占位符→image_slot 块；`<!--RUN_OUTPUT:run-N-->`→run_output 块不重编号；未知结构→raw 块原文）；迁移 v12 article_documents 派生缓存；normalize_ir（ArticleIR→同一文档/Markdown 链，未注册类型拒绝）；RPC articles.document（含图位候选 join）。验收：V-002 内 tests/test_v2_editor.py 9 项（含共享 fixture 块类型序列+字节往返）；发布快照不改（只读快照语义未动）。
- M3-02 Tiptap双模式编辑器 — **完成**。实现：desktop/ui features/editor/（markdownBridge.ts remark+gfm→Tiptap JSON、docToMarkdown 序列化；ImageSlot/RunOutput/RawBlock 自定义节点；StarterKit 富文本工具栏；源模式 CodeMirror 6 动态加载，运行时异常回退 textarea）；后端规则 lint 复用（evidence_errors 在 save_body 返回）。验收：desktop/tests/editor-markdown.test.cjs 5 项（字节 round-trip、幂等、raw/HTML 保留、占位符字段）+ 共享 fixture 与 Python AST 序列一致。
- M3-03 稳定图位节点 — **完成**。实现：imageSlot 原子节点（figureNo/caption/kind/obtain attrs）；remark image 节点识别还原；Python image_slot 块双向序列化原样；figure/P 编号映射承接 asset_slots.figure_no；删除图位块仅移除正文引用（不动 asset_candidates/原图）。验收：编辑器往返测试含图位字段完整性；删除语义在 apply_proposal_ops(delete) 测试覆盖。
- M3-04 真实保存与恢复草稿 — **完成**。实现：editor_drafts 表（账号+文章键，hash 幂等）；UI debounce 保存工作草稿+显式"保存新版本"走 articles.save（复用 save_body：预期 hash 冲突保护、"正文已变化"错误保留本地内容）；工作草稿与审批稿/导入原稿分离存储。验收：V-002 幂等与账号隔离测试；rapid save 无重复 revision（changed=false 路径）。
- M3-05 选段上下文与Patch模型 — **完成**。实现：edit_proposals 表（基线 revision+基线文档快照+逐项 ops+reason/source_turn）；ops 白名单（replace/delete/insert_after）+ 基线块指纹即时校验（过期基线提案当场拒绝）；模型不能写任意路径（op 结构封闭，无自由字段写入）。验收：V-002 提案创建/过期基线拒绝测试。
- M3-06 逐项对比与采纳 — **完成**。实现：UI PatchReview（逐项前后对比、接受/拒绝/改后接受/采纳全部未决定项）；decisions 逐项提交 articles.proposal_decide；应用经 editorial.apply_proposal_ops 生成新 revision（来源=人工采纳，走 save_body 记账+evidence_errors）。验收：V-002 accept/new_text/insert 测试（插入位置正确、改后接受覆盖提案文本）。
- M3-07 三方冲突与安全重基 — **完成**。实现：SequenceMatcher 块指纹对齐重放；基线块被人工改过/删除→记 conflict 不覆盖；不冲突块安全应用（partially_applied）；冲突原因逐项展示；旧提案处理后仍可读（include_decided）。验收：V-002 test_manual_edit_conflicts_old_proposal_and_replays_safe_blocks（人工段保留+未冲突段重放+处理记录可读）。
- M3-08 版本历史及恢复到新版本 — **完成**。实现：articles.revisions/compare/restore 复用 v1.5.3（不可变 revision+before_edit 链）；恢复=以旧版内容生成新 manual revision，不删除后续历史；提案与草稿跨版本可读。验收：V-002 test_restore_keeps_history（版本数递增断言）。
- M3-09 审批同步版本锁定 — **完成**。实现：articles.approval_status（正文级锚点=creative_asset_handoffs 采纳交接 hash；workflow 关卡摘要；pending 审批）；只读比较不篡改历史；UI 审批过期横幅。验收：V-002 test_approval_stale_after_body_edit（交接 hash 过期判定+历史记录不变）。语义记录于 DECISIONS ADR-014。
- M3-10 M3编辑器旅程验收 — **完成（后端全链+UI 打包冒烟）**。实现/证据：J03 冲突保护=V-002 三方冲突测试；长文/代码/表格raw/图位=共享 fixture 与编辑器往返；原文件 hash 不变=save_body 哈希链；新旧正文导出兼容=round-trip 字节测试。UI 旅程人工验收（快速切页/IME 实操）列入最终 EXE 验收清单（V-010 冒烟挂载通过）。

## M4 知识检索、ContextPack与选题

- M4-01 导入服务与来源模型 — **完成**。实现：ice_agent/knowledge/（parse_source：md/txt/docx；DOCX 用 stdlib zip+XML 且解析前拒绝 DOCTYPE/ENTITY；10MB 上限；PDF 明确拒绝并提示转换路径——ADR-016 按需插件延后，不假装支持）；knowledge_sources 表 UNIQUE(account,sha256) 幂等去重；原文只读不复制。验收：tests/test_v2_knowledge.py（幂等导入/坏文件诚实报错/原文件字节不变）。
- M4-02 段落/章节切块与引用定位 — **完成**。实现：chunk_text（标题分节路径/段落成块/代码整块/超长句界二分；span+section+chunk_hash）；历史正文经 sync_article_source 入索引（origin=article，hash 变更替换）；chunk 绑定 source/article/revision。验收：V-002 知识测试组。
- M4-03 FTS5探测与中文索引 — **完成**。实现：迁移 v13 内建运行时探测（不可用时记 knowledge_meta 并整体降级）；trigram 索引 ≥3 字查询；1–2 字固定走 LIKE（escape+参数化+限页）；搜索 SQL 全字面量+命名参数恒定结构。验收：3 字中文/英文/1-2 字中文/无命中/FTS 不可用路径测试（V-012）。
- M4-04 索引增量更新及恢复 — **完成**。实现：sync_article_source hash 跳过/变更替换；delete_source 连带清理；reindex_pending 启动续建（indexed_at 未完成来源重建 FTS）。验收：test_sync_article_reindex_and_delete、test_reindex_pending_resumes（删 FTS 后重建可续）。
- M4-05 全文搜索与引用UI — **完成**。实现：knowledge.search RPC（过滤 source/origin、分页、bm25 排序、snippet『』标记）；UI KnowledgePanel（检索/高亮/出处/导入文档按钮→ice:pick-knowledge-file 对话框）；citationStore 手选引文（≤8 与后端一致）+ 对话输入区引文 chips。验收：V-010 冒烟（知识检索面板渲染）；行为测试 V-012。
- M4-06 ContextPack编排 — **完成**。实现：prompts.render_template（显式变量+必需缺项报错+静态 JSON 花括号保留）与 template_snapshot（id/version/hash/declared_vars）；knowledge.build_context_pack（分层预算：规则>brief>手选引文(优先+hash绑定)>检索>历史，每层声明截断；资料只是数据，守卫在首层）。验收：V-012（截断声明/引文 hash 绑定/花括号/缺变量/注入资料不影响守卫/旧 PROMPTS fixture 锁定 version=1+节点集合）。
- M4-07 历史拟题覆盖与解释 — **完成**。实现：publication_history.title_coverage（总数/完整返回/分批区间/正文可用数——覆盖证明）；既有 context 已返回全部标题+前五篇实际数量+预设题优先（locked_title 链路既有）。验收：220 标题全覆盖断言、不足五篇实际数量断言（V-012）。
- M4-08 任意栏目排期管理 — **完成**。实现：12 自定义栏目写入账号配置→EditorialTopics preview/save 分批导入 12×200=2400 题；冲突需显式 replace_existing；下一期=已发布+1+同期草稿提示（既有 context 字段断言）；KI-001 期号边界修复（10000→9999 口径统一）。验收：V-012 规模/冲突/下期/边界测试。
- M4-09 重复选题与承接关系 — **完成**。实现：knowledge.duplicate_topics（完全同名/包含关系确定性规则+FTS 检索命中，逐条给原因；note 明示可坚持选题，不伪造点击率）。验收：V-012 解释命中测试。
- M4-10 M4检索与规划评测 — **完成**。实现：tests/test_v2_knowledge_eval.py（1008 篇合成文章/3024 分块/3 账号隔离；索引耗时+长/短查询 P50/P95/misses；结果 JSON 落盘）。实测：索引 56.5s；长查询 P95=3.09ms、短查询 P95=1.07ms（远低于报告 1s 目标）；隔离断言通过。证据：.test-tmp/v2-keval-*/knowledge-eval.json。

## M5 受限编辑Agent与对话闭环

- M5-01 工具注册表与授权等级 — **完成**。实现：ice_agent/agent/registry.py（18 项工具固化注册，模块断言必须覆盖报告 §11.2 全集；pydantic extra=forbid 参数模型；read/propose/action 三层——action 仅 create_production_task/submit_review；超时/输出上限/幂等标记；ToolExecutor 校验→执行→截断）。SQL 独立于 registry（agent/storage.py）。验收：tests/test_v2_agent.py 注册表契约+未知工具（run_shell/approve_execution）拒绝+越权参数拒绝。
- M5-02 模型tool_calls适配 — **完成**。实现：agent/adapters.py（parse_native_tool_calls 原生路径 + parse_action_envelope 降级路径；normalize_model_output 按能力分派；畸形参数/缺 calls/未知形状记 parse_error 反馈而非中断；正文其他 JSON 是资料不是指令）。验收：双路径同参数同权限测试、畸形安全拒绝测试。
- M5-03 有界工具执行循环 — **完成**。实现：agent/loop.py（agent_runs/agent_tool_calls 持久化；默认 6 轮/12 次上限；同工具+同参数 hash 连续两次失败熔断；cancel_event 每轮/每次调用前检查，取消置 run=cancelled；args_hash 幂等键）。验收：持久化断言、max_calls/max_rounds 触达、熔断 2 次即停、取消后状态一致。
- M5-04 检索与Brief工具落地 — **完成**。实现：search_articles（knowledge.search 真实调用）、read_article_revision（revisions+账号校验+受限长度）、get_column_context（context+title_coverage）、resolve_brand_rules（账号配置）、create_or_update_brief（agent_briefs 版本化+字段级 provenance）、request_user_input（agent_questions 持久化）。验收：全部走真实服务的测试（V-013）。
- M5-05 起草和选段改稿工具 — **完成（核心）**。实现：generate_outline（骨架候选，不写批准正文）、propose_article_patch（真实走 articles.propose_patch→edit_proposals，M3 冲突保护链）、propose_topics（历史查重提示不硬拦）、compose_image_prompt/propose_image_plan（候选不执行）。验收：注册层调用真实服务；起草→两次改段全链在 chat.send 集成后补旅程（M5-10）。
- M5-06 行动卡与流式对话 — **完成**。实现：chat.send 的 _generate 完成段检测 ActionEnvelope → AgentLoop 执行（取消事件透传、记录持久化、agent_run_id 写消息 metadata、循环失败不吞回复）；UI AgentActionCards（真实 tool_calls 记录渲染，无伪进度）。新增循环语义：整轮重复已成功的相同调用集 → model_repeated_calls 收口（不空转烧预算；失败轮走熔断、取消优先）。验收：tests/test_v2_chat_loop.py 3 项（patch 模型约定：信封回复真实执行+行动卡读取、普通回复零 run、取消路径 run 终态）。
- M5-07 澄清问题持久续接 — **完成**。实现：request_user_input 持久化 question_id；agent.questions/agent.answer_question RPC；重复回答不覆盖（历史可查）；未知问题 id 过滤。验收：V-013 续接测试。
- M5-08 会话记忆与摘要版本 — **完成**。实现：agent_briefs（版本化+字段级 provenance 分离用户/模型事实）；chat.summary RPC（确定性核心摘要：轮次/最后意图/brief/已答澄清，covers_from/to 涵盖范围，conversation_summaries 表唯一+更新不重建，原消息全部保留）。验收：V-014（版本递增、来源分离、摘要涵盖推进、账号隔离）。
- M5-09 Agent到工作流与资源工具 — **完成（核心）**。实现：create_production_task（TaskQueue 幂等键，重复折叠）、list_task_status、prepare_execution（只读摘要，明确 Agent 无权批准）、inspect_run_evidence（RunRecord 只读：exit_code/verdict/expected_failure 真实字段）、bind_asset_candidate（slot/candidate 归属校验的建议）、submit_review（chat.submit 真实 dispatch）、prepare_export（预检）。验收：幂等任务/绑定校验/只读语义测试。
- M5-10 M5安全与完整对话旅程 — **完成（后端链+安全）**。实现：注入资料不产生工具调用（含信封缺 calls→parse_error）、无 shell/无越权工具、账号域读取拒绝、同失败熔断、幂等任务、重复调用收口、取消贯穿（queue/chat/loop 三层）。J02/J07 的完整 UI 旅程列最终 EXE 验收清单（V-010 冒烟已含行动卡渲染）。

## M6 工作流编排、最小重跑与审阅

- M6-01 节点合同与输出验证 — **完成（IR 接入）**。实现：editorial.accept_model_draft（```json 包裹或纯 JSON 的 ir_version=1 → normalize_ir → 同一规范化链转 Markdown；校验失败原文回退，不抛错不跳过后续检查）；node_draft 接入（ir_used 记入 state，不建第二份正文）。验收：tests/test_v2_workflow_review.py（IR 信封转换/坏 IR 回退/纯 Markdown 不动）；同预算计数由既有 invocation 机制保证。
- M6-02 依赖失效与最小重跑 — **完成（映射层）**。实现：workflow/invalidation.py INVALIDATION_MAP（title/body/code/asset/rules/outline → 受影响节点集合，代码化报告 §12.2 表）+ workflow.invalidation RPC（stale/keep/reasons 解释）；改标题不重跑 verify_code、改代码不重跑 title_workshop 有断言。验收：V-014 五组映射测试。节点级 cache key 失效（改代码使 run/截图失效）随 M7-06 图位映射深化。
- M6-03 自动准备与逐步模式统一 — 已有（v1.5.3 production_mode=auto_prepare/review_each 同审批代码路径），本轮无回归；结尾统一审阅由 M6-06 聚合视图承接。
- M6-04 多期批量队列 — **完成（计划层）**。实现：workflow.batch_plan RPC（逐篇预算、并发上限 1–8 校验、超限篇目 priority 降级排队、前篇依赖显式声明、单批 ≤50）；执行复用 TaskQueue 租约/取消/恢复（M1-06 已测）。验收：V-014 计划结构+依赖+非法并发拒绝；3 篇重启恢复沿用 V-003 恢复演练语义，J04 全链列最终验收。
- M6-05 工作流图与受限模板 — **完成（投影层）**。实现：workflow.graph RPC（steps 表真实状态+任务 current_node 推断，14 节点顺序边；账号域+任务不存在规范化）；UI WorkflowGraph.tsx（@xyflow/react 只读投影：状态色/attempt/错误/当前边动画；nodesDraggable=false、不可连线——纯投影无脚本节点）。验收：V-016 图数据+UI 冒烟；重跑预览联动 workflow.invalidation。模板版本绑定随既有 spec_json 快照语义。
- M6-06 统一审阅中心 — **完成（聚合层）**。实现：review.center RPC（内容/事实/代码/图/导出五节聚合：正文统计+claims 及未核验数+runs exit_code/verdict+图位候选状态+占位符与 readiness；账号域+任务不存在规范化 ValueError）。验收：V-014 聚合结构/证据齐备/账号隔离测试。逐项通过/退回 UI 交互随 M2 面板扩展（数据层已就绪）。
- M6-07 事实与规则定位 — 已有基础（claims 表 risk_type/status/publish_day_check_required + rules 模块），聚合视图已暴露未核验计数；语义疑点模型侧随 M8-05 评测样例深化。
- M6-08 任务可见性与删除恢复 — 已有（v1.5.3 task_lifecycle：archive/delete/restore 不级联删文章/证据；jobs.list visibility 过滤），本轮 V-002 回归覆盖。
- M6-09 审阅变更与依赖通知 — **完成（基础）**。实现：M3-09 审批过期（approval_status.stale）+ M6-02 失效解释组合覆盖"批准后改稿提示过期"；批量等待项解释由 invalidation reasons 与 list_task_status 承接。
- M6-10 M6恢复与审阅journey — 进行中。后端聚合+失效+批量计划+恢复（V-003）已测；J04 三篇自动准备全链列最终验收清单。

## M7 视觉资产、提示词与内嵌浏览器

- M7-01 资产元信息与去重引用 — **完成（核心）**。实现：v16 表 + assets_v2（下载去重 by sha256；7 张品牌原图沿用 style_presets hash 不变；资源元信息沿用 WorkspaceAssets metadata）。跨账号不泄露由既有账号域保证。验收：V-015。
- M7-02 资源库筛选与批量操作 — 既有（resources.list 筛选/原图 viewer v1.5.3 已验收），本轮无回归。
- M7-03 StylePack版本与批准 — **完成**。实现：style_packs 表（版本递增 UNIQUE、draft/approved、默认包只读展示）；7 原图 hash 不变（style_presets 未动）；可编辑区/保护区字段进 pack_json。验收：V-015（默认→版本1→批准→版本2）。
- M7-04 提示词编译器与lint — **完成（lint 层）**。实现：assets_v2.lint_prompt（七要素确定性检查：use_case/canvas/colors/exact_text/layout/style/forbidden；期号残留警告；真实终端被生图替代警告；score_25）；编译复用 image_prompts.assemble（未动）。验收：V-015（完整 25 分/缺项/期号残留/实截警告）。
- M7-05 Prompt版本与候选流程 — **完成**。实现：prompt_revisions 表（account+job+figure+version UNIQUE；origin=agent/user 区分；prompt_hash；lint 随存）；RPC promptv.save/revisions（改名避让既有 prompts.*，KI-012）。人工修改优先=新 origin=user 版本不覆盖旧版本。验收：V-015。
- M7-06 图位到Run精确映射 — **完成（绑定层）**。实现：slot_run_bindings 表（UNIQUE per slot；source_hash 与 checkpoint runs 的 code_sha256 校验不符拒绝；expected_error 必须显式批准）；RPC slots.bind_run/run_binding。验收：V-015（匹配绑定/预期错误未批准拒绝/批准后通过/hash 不符拒绝/未知 run 拒绝）。截图消费侧（capture 只用绑定 run）随 M7-10 旅程接 automation。
- M7-07 浏览器大空间与遮挡修复 — 既有（v1.5.3 WebContentsView/弹窗让位/专注模式已验收），本轮无回归。
- M7-08 下载待归档与图位绑定 — **完成**。实现：download_staging 表 + assets_v2（MIME magic 校验扩展名不符拒绝；同 sha256 去重；pending→bound/discarded；discarded 不可再绑——取消不生成就绪候选）；RPC downloads.stage/bind/list。验收：V-015（magic 拒绝/去重/绑定/丢弃后拒绝）。
- M7-09 浏览器会话与任务上下文 — 既有（partition 隔离/清理范围 v1.5.3 已验收），本轮无回归。
- M7-10 M7视觉与截图端到端 — 进行中。绑定/归档/lint 后端链已测（V-015）；J05/J06 全链（含截图消费绑定 run、TapNow 手工流）列最终 EXE 验收清单。

## M8 模型治理、预算、运维与容量

- M8-01 能力注册与分项探测 — **完成（登记层）**。实现：CapabilitySet 分项（text/stream/json_object/json_schema/tool_calls/vision/thinking/usage/evidence_date，documented/unknown 语义——unknown 不是 true，既有）；models.probe_capabilities RPC 分项实测（connection/stream/structured 逐项调用，tools 待真实接入标 unknown，vision 无样例 untested；无 Key=untested 不冒充）；结果写回 profile.probe_results 持久化。验收：V-017。真实 Key 探测列用户触发项。
- M8-02 SSE与结构化兼容加固 — **完成**。实现：transport._read_sse 已健壮（8MB 上限/总时限/损坏行/错误事件/usage 晚到/finish 校验）；本轮脱敏 fixture 逐类断言 6 类。验收：V-017。
- M8-03 统一调用归属与预算预留 — **完成**。实现：迁移 v16 model_invocations+conversation_id（索引）；router.generate 透传（_call 初始 INSERT 与 _record 双点携带）；creative_chat 会话预算预检（max_chat_calls，入口拦截消息不落库）；store.conversation_invocation_count。验收：V-015（归属计数真实路由、预算入口拦截）；不双计=同一条记录被任务/会话两视图读取；停止远端未知费用语义既有。
- M8-04 预算UX与可选金额估算 — 未开始
- M8-05 质量评测样例与路由策略 — **完成（规则/IR 层）**。实现：`python -m ice_agent.eval`（7 固定脱敏样例；规则 fixture 直接加载 resources/ice-loop.json 防口径漂移；JSON+退出码）。验收：V-017 exit 0；黄金对话集列最终验收。
- M8-06 结构化日志与诊断包 — **完成（健康层）**。实现：tools.health（版本/schema/队列/最近错误/调用归属/磁盘/FTS5）；tools.diagnostics 脱敏既有。
- M8-07 容量分类与安全缓存策略 — **完成（估算层）**。实现：tools.capacity 分类字节+证据不自动清理语义沿用。
- M8-08 本次运行与残留登记 — **完成**。实现：tools.staging_report（只列不删；junction/未知命名保留注明）。
- M8-09 性能与生命周期专项 — 部分完成。检索 P50/P95 已测（V-012）；200轮会话/原图20次开关列最终 EXE 验收。
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
