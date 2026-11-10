# v3.0 架构决定（工作台优先转向）

依据：`docs/上线准备/工作台优先转向-开发报告-2026-11-05.md`。编号接续 `docs/v2.0/DECISIONS.md`（ADR-001～017）。

## ADR-018 文章规范值：结构化文档 JSON，Markdown 只作投影（DOC-00，2026-11-05）

- **决定**：v3 的普通文章以 `documents` / `document_working` / `document_versions` 中的结构化文档 JSON 作为唯一规范值。JSON 与 Tiptap/ProseMirror JSON 同形，形如 `{"schema":1,"doc":{…},"style":{…}}`。Markdown 由 `ice_agent/documents/markdown_io.content_to_md` 生成，是只读投影，用于源码查看、AI 上下文、纯文本导出，以及导出包里的 `正文.md`。投影不能回存为规范值。
- **范围**：本决定只适用于新的普通文章。旧任务继续遵守 ADR-005（Markdown 规范值，ArticleDocument 为派生物），两套数据不混写。
- **块与标记**（前后端同表）：
  - 块：`paragraph`（textAlign）、`heading`（1–3 级，textAlign）、`bulletList`/`orderedList`/`listItem`、`blockquote`、`horizontalRule`、`codeBlock`。
  - 图片块：`articleImage{resourceId, caption, alt, width%, align, sourceUrl}`。
  - 原件岛：`rawHtml{html 已清洗原件, reason, deliver=text|html|omit}`，只读。
  - 旧稿占位：`rawBlock`、`imageSlot`、`runOutput`。
  - 标记：bold、italic、underline、strike、code、link（只允许 https/http/mailto）、`textStyle{color #RRGGBB, fontSize 受限集合}`。
  - 每个块带稳定 `attrs.id`。
- **校验**：后端 `documents/schema.normalize` 是唯一的安全边界。未知块降级为 `rawBlock`，保留原文字；未知属性丢弃；危险链接和样式被剔除。前端只做近似呈现。
- **理由**：见 `DOC-00-两路线样本对比.md`。当前未扩展的 Markdown 往返会丢失样式与图片属性，因此本期选择已有编辑器 JSON 加校验器，减少另建扩展语法和解析器的成本。这不证明受控 Markdown 扩展无法表达这些属性；尚未实现该替代原型。
- **影响**：
  - 交付渲染（B-04）直接读取冻结版本的 JSON。
  - 旧稿通过映射接入（ADR-019），转换时一次性生成 JSON。
  - 投影丢失的能力在 `documents.markdown` 的返回值 `lossy` 中显式列出。

2026-11-06 补记：v3.2 增加 `content.info`（作者、摘要、原文链接、封面）、首行缩进、字间距及高亮；P2 增加四主题和 `callout` / `imageGroup`。排期属于 `documents.meta_json.planned_date`，不是正文规范值 `content.info`；交付版本与运营元数据应分别验收。

## ADR-019 旧数据按映射接入，不批量改写（A-01，2026-11-05）

- **决定**：
  - 统一索引 `documents.list` 返回两部分：v3 文章，以及尚未接入的旧草稿（`publication_drafts`）和旧任务文章（`jobs`+`articles`，不含演示/纯配图/已隐藏的任务）。
  - 用户打开旧稿时，`documents.open_legacy` 新建一条 `documents` 记录，`origin=legacy_draft|legacy_job`，`origin_ref` 为原 id，并有唯一索引保证只映射一次。正文经 Markdown 转换后成为新文章的第一个版本（producer=legacy）。
  - 旧任务中已采纳的图片导入资源库（按 sha256 去重），转为真实图片块；没有采纳的图位保留为占位，不伪造。
- **不做**：
  - 不改写旧草稿、旧任务的正文与状态。
  - 不把 `articles.series/episode NOT NULL` 迁移成可空列。新文章的栏目和期号存放在 `documents.series/episode`，可以为空。
- **“复制为新文章”**：旧代码任务不能继续执行（ADR-020）。在首页点击“复制为新文章继续写”就是 `open_legacy`：生成一篇独立文章，原任务、审批、运行记录保持只读。旧审批仍然只绑定旧版本。

## ADR-020 代码执行退场（C-03，2026-11-05）

- **决定**：桌面工作台不再启动、批准、补输入或改写任何代码执行。
  - **渲染层白名单**：移除 `execution.approve`、`execution.inputs`、`execution.code_save`、`execution.policy_save`、`supplements.prepare`、`supplements.execute`。
  - **引擎层**：`DesktopService.RETIRED_EXECUTION_METHODS` 再次拒绝上述方法，错误码文本为 `[CODE_EXECUTION_RETIRED]`。
  - **Runner**：`_app` 中 `allow_local_exec=False`，并设置 `cfg.code_execution_retired=True`。
  - **工作流**：
    - 没有代码块的文章照常继续。
    - 有代码块的旧任务，即便存在有效历史运行，也以 `CODE_EXECUTION_RETIRED` 停止接续；历史 state 不改写，继续写作使用“复制为新文章”。
    - 不调用执行器，不伪造输出，不重新生成终端截图。主进程截图入口、后端 capture context/finish 和自动队列均拦截；历史截图文件不删除。
  - **原任务入口**：新工作台使用 `LegacyArticleView` 只读查看原正文、运行输出与旧编辑器工作草稿；继续编辑进入独立文章，不再直接挂载旧编辑器。
  - **Agent 工具**：`prepare_execution` 只返回代码块摘要并标注 `execution_retired`。
  - **新文章中的历史运行输出**：显示为只读徽标，交付时省略并给出提示。
- **兼容开关**：环境变量 `ICE_LEGACY_CODE_EXECUTION=1` 只供源码环境的 v1/v2 历史回归测试使用，`tests/__init__.py` 默认打开。安装包设置了 `ICE_PACKAGED=1`，在安装包中该开关被忽略，执行能力始终退场。

## ADR-021 交付 ≠ 发布；发布登记绑定已交付版本（B-04/C-05，2026-11-05）

- **决定**：
  - **冻结版本**：交付（复制富文本、复制纯文本、导出图文包）总是基于一个冻结版本。如果工作副本有未成版的修改，先自动存为 `producer=delivery` 的版本。
  - **复制**：
    - HTML 由引擎渲染，经主进程 `ice:document-copy` 写入系统剪贴板。渲染层不能注入任意 HTML。
    - 写入后回读确认，确认成功才记一条 `document_deliveries`。
  - **导出包**：包含原图字节（不重压缩，按正文顺序编号）、`正文预览.html`、`正文.txt`、`正文.md` 和 `manifest.json`。manifest 记录 version_id、delivery_hash、问题清单，以及“导出不等于已发布”。
  - **人工发布登记** `publications.register`：
    - 必须指定一个已交付过的版本。
    - `source=user_registered`，表示这是用户声明，系统不自动核验。
    - 之后的修改不会改写已登记的版本。撤销登记只把记录标记为 withdrawn。
  - **图片限制**：不预设公众号后台的人工上传限制，只在清单里记录每张图的格式、大小和像素，等 B-05 实测后再配置。

## ADR-022 网页会话与收藏按公众号隔离（C-02，2026-11-05）

- **决定**：
  - **会话**：浏览器保留 `wechat`、`tapnow` 两个固定会话，新增 `web` 通用网页会话。分区是 `persist:publication-web-` 加 `sha256(account + NUL + site)` 的前24位，沿用已有站点分区，不复制 Cookie。逻辑测试已覆盖隔离；原生登录需另验。
  - **地址路由**：地址栏和收藏按域名选择会话：`mp.weixin.qq.com` 进入 wechat 会话，`*.tapnow.media` 进入 tapnow 会话，其余进入 web 会话。
  - **收藏** `bookmarks.*`：
    - 按公众号存储。首次读取时播种默认收藏（微信公众平台、TapNow）。删除默认收藏后不会被再次播种，可以手动“恢复默认收藏”。
    - 只接受公开的 HTTPS 地址：不带账号密码，不接受 localhost。
  - **远程页面权限**：没有 preload，不暴露 IPC，不能访问本地文件。“在系统浏览器打开”只传 https 地址，不带应用会话。

## ADR-023 文章内助手走“提案链”，采纳在服务端按块校验（P1-01，2026-11-06）

- **决定**：
  - **提案先落库**：改写/扩写/压缩/改语气/图位建议/按要求修改，模型结果写入 `document_proposals`（迁移 v24），不直接改正文。每处修改是一个 op：`replace`/`delete`/`insert_after`，记录块 id、完整原块快照 `before`、用于展示的原文 `before_text` 和修改后的块。
  - **范围**：只改选中的顶层文字块（段落、标题、列表、引用），一次最多 12 段、8000 字；图位建议读全文但只插入待配图位。前后各一段、全文小标题、本号写作技能与文章规则作为只读上下文。
  - **部分采纳**：`documents.assist_apply` 只套用勾选的 op。套用前逐处比对块 id 与完整原块（含格式、链接、子节点）；文字或格式变了都标为“已过期”并跳过，图位插入同样校验锚点。前端检测未保存的编辑变化，服务端独立复核。历史无 `before` 的提案只回退到严格全文文字匹配，不能据此声称有格式保护；长锚点摘要不能冒充全文。提案仍可查看。
  - **版本与撤销**：采纳前若有未成版修改，先存 `checkpoint`“采纳 AI 修改前”；采纳后另存 `producer=ai` 版本，说明写明“x/y 处”。编辑器把结果作为**一个事务**载入，Ctrl+Z 一步撤销；“撤销本次采纳”在采纳后没有再改时恢复到采纳前版本，提案回到可再次采纳。
  - **生成中断**：生成在后台线程；应用重启后仍为“生成中”的提案如实标为失败，不冒充完成。
- **不做**：不保留行内颜色/字号等样式（Markdown 往返会丢），界面提示采纳后重新设置；不自动接受；没有全局 Enter 采纳。
