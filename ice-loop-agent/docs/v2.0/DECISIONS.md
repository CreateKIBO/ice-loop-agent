# v2.0 架构决定记录（DECISIONS）

每条含日期、理由、影响。新决定追加在末尾。

## ADR-001 保留 Electron + Python + SQLite 主体，新增 React/TS/Vite renderer（2026-10-07）

- 决定：不重写进程架构。新 UI 在 `desktop/ui/` 用 React+TypeScript+Vite 增量迁移，`main.cjs`/`preload.cjs` 保持 CJS 模块形态，不做全工程 ESM 迁移。
- 理由：v1.5.3 已有 21 表 schema、JSON Lines RPC、执行安全、浏览器隔离等大量已验收能力；报告 §5.1/§5.2 明确增量迁移。
- 影响：旧 renderer 页面过渡期保留（Shoelace），新页面用 Radix + 品牌 tokens；一条路由同一时刻只有一个渲染所有者。

## ADR-002 SQLite 迁移框架：显式编号 + checksum + dry-run（2026-10-07）

- 决定：基于现有 user_version 机制扩展 `schema_migrations` 跟踪表；迁移前用 SQLite backup API 生成一致备份；升级流程按报告 §6.2 的停写→备份→dry-run→执行→验证顺序。不固定"9→12"目标数字，编号按实际 schema 设计递增。
- 理由：矩阵 M0-08/M0-09；04-对照文件裁定不机械升 12。
- 影响：现有 `schema_version>9 拒绝打开` 逻辑保留并增强；自动备份文件名规则沿用。

## ADR-003 协议 v2 兼容 v1（2026-10-07）

- 决定：JSON Lines 保留，新增显式 `kind=response|event` 字段；未标记响应按 v1 结构解析。request_id/event_id/stream_id/sequence 齐备。PROTOCOL_VERSION 升 2，后端同时接受 v1 客户端。
- 理由：矩阵 M1-01/M1-02；旧 UI（轮询式）必须过渡期可用。
- 影响：`ice_agent/__init__.py` PROTOCOL_VERSION 变更；server.py 分派层加事件通道。

## ADR-004 编辑器：Tiptap 开源核心 + 自建版本/Patch；源模式 CodeMirror 或 textarea 降级（2026-10-07）

- 决定：Tiptap 仅用 MIT 开源核心包，版本/审批/Patch 自建；不引入任何 Pro/付费扩展。Markdown 源模式优先 CodeMirror 6 最小适配，加载失败回退 textarea。
- 理由：报告 §4.2/§9；04-对照 §3.5。
- 影响：`desktop/ui/` 新增 @tiptap/core 等核心依赖；具体版本经 M0-06 最小实验后锁定到 package.json 精确版本。

## ADR-005 单一正文真相：Markdown 规范值 + 可派生 ArticleDocument（2026-10-07）

- 决定：规范值仍是 Markdown（沿用 article_revisions.content）；结构化文档是可版本化派生编辑模型，同一次保存中校验一致。ArticleIR 仅是生成交换格式，转 ArticleDocument 后不保留第二份长期正文。旧 `<!--RUN_OUTPUT:run-N-->` 引用兼容保留。
- 理由：报告 §5.3；04-对照 §3.1。
- 影响：M3-01 实现 ArticleDocument 派生与 hash 校验；不重编号既有 revision。

## ADR-006 检索：SQLite FTS5 + 中文短词受限查询降级（2026-10-07）

- 决定：FTS5 运行时探测可用性；可用时 trigram/unicode61 索引长查询，1–2 字短词走独立词项/substring 受限查询；FTS5 不可用时整体降级为 LIKE 分页查询。不引入向量数据库。
- 理由：SQLite 文档明确 trigram <3 字符不匹配；矩阵 M4-03。
- 影响：retrieval 模块需要三层策略测试（3+字/1-2字/无FTS5）。

## ADR-007 Agent 工具：代码白名单 dispatch，不执行模型 shell（2026-10-07）

- 决定：18 项工具在 Python 端注册表硬编码（name/schema/permission/budget/timeout/idempotency）；模型输出原生 tool_calls 或 ActionEnvelope JSON 均经同一注册表校验。无任意 shell 工具；执行代码仍走既有 execution.approve 批准链。
- 理由：报告 §11.2；安全边界。
- 影响：`ice_agent/agent/` 新模块；creative_chat 现有讨论/候选路径保留为底层服务。

## ADR-008 本地持久队列，不引入外部消息中间件（2026-10-07）

- 决定：任务队列用 SQLite 表 + lease/heartbeat 实现，有界线程池执行；不引入 Redis/Kafka/Celery。
- 理由：报告 §7.3、§4.1 边界。
- 影响：`ice_agent/tasks/` 新模块，jobs 表 lease 机制扩展为通用队列。

## ADR-009 DOMPurify 双许可记录为 Apache-2.0（2026-10-07）

- 决定：DOMPurify 按 Apache-2.0 许可采用并在 DEPENDENCIES.md 记录（非 MIT）。
- 理由：notes.md 明确双许可事实。
- 影响：许可清单。

## ADR-010 预算统一归属：invocation 模型扩展（2026-10-07）

- 决定：model_invocations 表扩展 conversation_id/run_id/tool_call_id 归属字段（迁移新增列），创作对话与制作任务共用同一预算预留/账本；次数与金额分开（金额仅用户配置价格时估算）。
- 理由：矩阵 M8-03；notes.md 指出现状"创作讨论不计数"。
- 影响：M8 阶段迁移；不双计。

## ADR-011 工作流保留现有引擎，不另造平台（2026-10-07）

- 决定：沿用 engine/nodes/checkpoint/lease/approval/ledger；React Flow 仅作状态投影与受限模板配置，禁止任意脚本节点。
- 理由：报告 §12.1。
- 影响：M6 在现有 workflow 模块上增量。

## ADR-012 打包：新 UI 与新 Python 依赖进入同一冻结流水线（2026-10-07）

- 决定：`build/build-release.ps1` 更新以包含 desktop/ui 构建产物（esbuild/Vite 构建进 asar）与新增 Python 依赖（PyInstaller spec 更新）；最终包不能只 repack-ui。electron-builder files 白名单显式加入 `ui/` 与 `main-services/`。
- 理由：矩阵 M9-06；任务书 §八 明确。
- 影响：M9 阶段构建脚本改动；期间保持现有 release 脚本可运行。

## ADR-013 提案基线快照与重放语义（2026-10-07）

- 决定：EditProposal 创建时把基线文档整体快照进提案行（base_document_json）；base_revision='current' 表示提案创建时刻的正文。采纳时以快照为 base、当前稿为 theirs，SequenceMatcher 按块指纹对齐重放：块未变→应用；被人工改过/删除→逐项记 conflict；不冲突项安全应用生成 partially_applied 新版本。
- 理由：任务可能尚无人工 revision（workflow 产出的 integrated_md 不在 article_revisions），快照使重放不依赖文档重建；指纹对齐可解释且可测。
- 影响：M3-05/06/07 实现；提案行体积增大（可接受，正文 ≤100KB）。

## ADR-014 审批锁定锚点=配图交接 hash（2026-10-07）

- 决定：正文级"审批基线"取 creative_asset_handoffs（chat 候选采用→配图交接）登记的 content_hash 作为锚点；articles.approval_status 只读比较当前正文 hash，不一致即 stale，不修改任何历史审批记录。工作流关卡（topic/outline 等）仅作摘要展示，不冒充正文审批。
- 理由：v1.5.3 中真正锚定"正文某版本被批准"的数据是候选提交/交接链的 content_hash；approvals 表的关卡 hash 对应生成节点而非正文。不虚构新审批语义。
- 影响：M3-09 实现；J09 导出预检复用同一 stale 判定。

## ADR-015 前后端 Markdown AST 共享 fixture（2026-10-07）

- 决定：tests/fixtures/editorial-sample.md 为 Python editorial 与前端 markdownBridge 的共同 fixture；两侧测试各自断言相同块类型序列与字节级 round-trip（前端不含文件尾换行）。
- 理由：矩阵 M8-05 要求两 AST 一致 fixture；M3-02 往返保真。
- 影响：remark-gfm 引入（表格→raw 块与 Python 对齐）；后续新块类型需两侧同步登记。

## ADR-016 PDF 导入延后为按需插件（2026-10-07）

- 决定：knowledge.parse_source 对 .pdf 明确拒绝并提示转换路径（MD/TXT/DOCX）；不引入 pdfminer/MarkItDown 依赖，等真实 PDF 需求出现时按 §4.1 选型流程最小验证后再加。
- 理由：报告 §10.1 将 DOCX/可提取 PDF 定义为"增强"；当前无用户 PDF 样本，装了依赖也无法验收解析质量；诚实拒绝优于假装支持。
- 影响：M4-01 验收含"失败不报成功"；后续接入时补 parser='pdf-v1' 与对应测试。

## ADR-017 历史正文经 sync_article_source 进知识索引（2026-10-07）

- 决定：文章/历史正文以 origin='article'、article_id='history:{history_id}' 进 knowledge 索引；重复选题检查等消费场景在查询前同步（hash 不变跳过）。
- 理由：M4-02 要求 chunk 绑定 article/revision；M4-09 检索命中需要正文已索引。
- 影响：检索结果可定位回历史记录；重复导入幂等由 source hash 保证。
