# 最新候选对照与操作体验（2026-10-25，优先于下文）

GLM 六批36项 done36。新能力：当前页两份候选只读对照（恰两份/去重/三选拒绝；并排≥1280/500堆叠；局部目录 AST 级不含围栏伪标题；回到开头双态滚动；各自复制此份原文；翻页/切会话清空选择；零写类 RPC 断言）；参考区三态（读取中/失败/暂无）+行身份+带编号文件名复制+文件名清单；帮助四主题示例。candidate-compare 原生 19 项（已注册）、reading-upgrade 24 项（seed 扩展同题/跨页候选）、单测 9/9、统一 quick+双原生 10 步 complete=true。首次失败（选择器顺序/滚动不足/DOM对象返回/分页深度/前缀误匹配）均定位为测试编写并保留证据。未提交/推送/提版/打包；保护区零改动；Python 未重跑。

---

# 最新复制与阅读升级（2026-10-25，优先于下文）

GLM 六批36项 done34/deferred2/blocked0。关闭审阅 R1/R2/R3：复制专项改固定行（data-download-id+行内 aria-label，成功必现该行反馈、注入 ok:false 必现失败）；CopyButton 轮次化（新操作清旧成功/失败不留成功/text 变化撤销/卸载清计时器，copy-button-native 7/7 真实组件旅程）；上批统计更正 15/31/1 并撤回轮询推测。新功能：候选稿原文/阅读双视图+字符统计+复制全文；任务列表恢复默认视图（白名单单键、零写 RPC）；参考图折叠+文件名复制+提示词字符统计。统一 quick+reading-upgrade 8 步 complete=true；clipboard 分支单测 5/5。延期 B6（候选展开后轮询回落）/D6（配图工作台在复位前置后瞬现即失）——产品代码已完成，复现证据与疑点在交接文档。未提交/推送/提版/打包；保护区零改动；Python 未重跑。

---

# 最新界面体验打磨（2026-10-25，优先于下文）

GLM 八批48项 done14/reused32/deferred1（F6 恢复默认视图无承载页延期）。修复真实缺陷：ice:copy-text 返回 {ok:false} 被 clipboard.ts 丢弃→剪贴板拒绝仍显示已复制（现抛错走失败 toast）；新增候选卡复制全文、提示词未保存徽章、下载完整路径复制。新 ux-polish 原生（截图+真实键盘+trace 写次数断言）注册入统一入口；最终统一 quick+ux-polish+workflow-views+chat-delivery 12 步 complete=true/sourceChanged=false，motion-feedback 28 项过。交回：轮询列表中 CopyButton 视觉状态不更新（复制真实成功、无假成功；探针证据在交接文档）。报告：docs/迭代任务/GLM-界面体验打磨执行记录-2026-10-25.md；证据 .test-tmp/glm-ux-polish-20261025/。未提交/推送/提版/打包；保护区零改动；Python 未重跑。

---

# 最新体验完善（2026-10-23，优先于下文）

GLM 七批42项：A6 入门清单可收起+按可观察数据打勾（账号偏好、坏值回退）；B2 会话头常显写作模型与“未关联期号”说明；42项 done6/reused29/deferred6/blocked0（逐项表见执行记录）。修复上轮遗留 interaction-lists 失败根源：localStorage 跨运行保留 ice.ui.jobview 偏好把 completed 卡滤掉（产品行为正确、测试隔离缺口）+ 脚本“第一个 checkbox”命中新增紧凑开关——已加清键+定时 reload 前置与 aria-label 精确定位，单跑与统一链 10/10 complete=true。统一 quick 6 步过、typecheck/build 过、start-checklist 单测 2/2、glm-review/integrity 回归过；upgrade-transaction 一次抖动单跑 19/19。复查后新增 start-guide 专项 9 项并修复本轮引入的真实缺陷（收起清单时参数语义接反致偏好永不写入，单测测不到接线、用户路径旅程复现）；统一 quick+start-guide 8 步 complete=true；42 项统计修正 done7/reused32/deferred3。报告：docs/迭代任务/GLM-体验完善执行记录-2026-10-23.md 与交接文档；证据 .test-tmp/glm-polish-20261023/。未提交/推送/提版/打包；保护区零改动；Python 未跑（历史基线仅引用）。

---

# 最新Token预检与设置恢复（2026-10-22，优先于以下历史）

本轮实际开发：llm/admission.py接入智谱官方tokenizer、文档枚举10模型与精确官方端点；完整messages/总Token，输入加明确输出预留超窗口时不生成不占本地生成次数。auto/required/off、手动窗口（用户来源，端点模型绑定、切模型清除）、CAS与冻结快照。主模型required禁止备用绕过。未知不冒充通过、不裁剪前五篇全文/所有标题。原180k字符保护仍独立。

计数复用有界HTTP/取消/总时限；32摘要计数/5分钟缓存，不留正文或明文Key；预算前只读检查，生成前事务再检查。创作及账本保存回执，包含被拦截数字，前端不接受损坏数字为通过。费用语义明确：计数为额外供应商请求，不计本地生成次数，供应商计费另行确认。

真正修复保存后读败：TanStack默认不抛错，开启该表单错误传播后复现旧props回滚；现用确认bootstrap安装账号精确缓存，取消旧读取，refreshAfterWrite只读恢复。故障注入保持保存1次，输入150不退回。

最终Python完整离线752/752，167.438s，唯一ID/无跳过，源摘要前后及当前一致；Node261/261、类型/构建/资产图过；Token原生17、旧设置11、主工作台39过（累计67，交叉覆盖）。首轮完整752有40秒精确超时旧断言失败，保留日志，按共同截止语义修正后完整重跑；另有真实回环.25s联合截止与socket关闭证据。

报告docs/迭代任务/Codex-Token预检与模型窗口恢复-2026-10-22.md，汇总.test-tmp/codex-token-admission-20261022/final-result.json。界面原生供应商响应为离线替身，不是真云验收；GLM-5.3-Flash未在官方计数枚举内，Qwen/DeepSeek/Kimi/Ark/MiniMax/代理未接通计数，严格会拦，auto明确未知。显式连接/能力探测仍为独立流程，不扩展本报告范围。无需重复给GLM相同交互测试；后续由真实官方契约/云/冻结发行证据推进。

仍beta.2、HEAD4513985，未提版打包推送/新依赖/迁移；保留全部既有改动。多小时RSS、真机DPI、TapNow在线和NSIS仍待验，整体发布目标未完成。

---

# 最新下载与资源生命周期修复（2026-10-22，优先于下方历史）

已在实际E盘源码继续开发：真实下载复现异步setSavePath导致图片残留.pending；现改同步原生保存选项+完成读取实际路径。下载固定来源account_id，后端验证账号；reset/close取消未完成项并移除自有session监听器，隐藏保留、Cookie和已完成文件不删除。旧命令晚到不操作新page。归档改32MiB上限/1MiB分块SHA/读取前后stat，32MiB测试仅Python分配峰值2.01MiB（非应用RSS）。

最终Python完整离线721/721、唯一ID无重复、无跳过、源码未变；Node258/258、真实Chromium下载32、主应用联动39全过。独立新runtime、原生runner源摘要稳定；原生保存位置同步注入，未实际点击Windows原生保存框。全树内存采样排除了采样器自身；16次循环页面/下载监听器/临时文件检查通过，不能声称多小时RSS稳定。

报告docs/迭代任务/Codex-下载归属与浏览器资源生命周期-2026-10-22.md；汇总.test-tmp/codex-browser-lifecycle-20261022/final-result.json。仍为beta.2/HEAD4513985，未打包提交推送，保留全部既有改动。真实模型Token窗口/Key、TapNow在线、NSIS及长时压力仍未验，整体发布目标继续开放。旧段落的715/721等数字保留各自历史身份。

---

# 最新制作流程继续开发（2026-10-22，优先于以下历史段落）

GLM六批用户流程已核对并继续补修。实际起点Node248/249，新增控件命名检查失败；已补明确aria-label。真实复现并修复下载切目标后旧图位仍可绑定，改账号+任务键控读取、即时清空、选择验证与flush；写入成功后锁定绑定/交付确认，读取失败只重读且同步相关缓存。补任务queued筛选、范围/建议语义、原因脱敏、偏好读长度、大纲摘要memo及窄栏排版。

复用完整真实引擎/图片/事实/执行证据夹具，新增delivery-ready28项：hash冲突、三连点确认一次、读败恢复、目录取消、真实MD/TXT/图片校验、图片变更过期与draft缺项。系统选择和shell打开明确注入。最终统一22步全过、Node252/252、源码摘要稳定；8原生172项，补大纲31项，合计9组203项（交叉覆盖）。大纲旧测试仅同步新覆盖按钮名后复跑，产品代码未再改。PS5.1多行输出被当路径问题已修并有正反回归。失败记录全部保留。已知所属进程0残留。

Python全量本轮未跑，715为历史；ice_agent无Git改动。无真实云/TapNow/微信/NSIS/物理DPI/长期RSS结论。HEAD4513985；未提交、推送、提版、打包。

报告：docs/迭代任务/Codex-制作流程闭环与交付完善-2026-10-22.md；机器汇总：.test-tmp/codex-workflow-continuation-20261022/final-result.json。新专项已登记统一入口，使用-PrepareNativeFixtures逐项播种。

---

# 最新三批十二项独立验收（2026-10-22，优先于下文）

GLM 交付已独立复验并补修：CommandPalette 同 tick 三连点实际创建3会话→同步 ref 防重只创建1；统一验收拒绝空操作 seed、旧/缺失结果、错 runtime、失败状态与 false 断言，先守卫再归档；StrictMode 补真实打开态卸载与 opener 焦点前置、完整 timer 参数转发和所属进程收尾；编辑器三旅程 runtime/fixture 对应且精确新建一次；配图缺必要图位即失败。

实际 Node244/244、PS5.1行为9/9（已包含）、统一quick+9原生24步全过complete=true/sourceChangedDuringRun=false。原生11组累计209断言，交叉覆盖。统一运行后仅再加强StrictMode测试前置并重跑15项，原轮询4项也通过；产品代码未再改。所属测试进程残留0。Python未重跑，715为历史基线；后端无Git改动；真实云/TapNow/微信/NSIS/物理DPI/RSS未验。未提交、推送、提版、打包。

报告：docs/迭代任务/Codex-后续工程独立验收与修复-2026-10-22.md；机器汇总：.test-tmp/codex-engineering-audit-20261022/final-result.json。本轮十二项无已知阻断项交回GLM；下一轮按真实用户功能另定范围，避免重复扩充相同测试或混入模型/迁移/安装领域。

---

# 最新交互专项独立验收（2026-10-21，优先于下文）

GLM 报告的“IPC 挂起”具体失败已定位：测试 wrapper 对非 ice:request 不调用 fn 且返回未定义 result；任务夹具没有检查点，真实拒绝未入日志。已抽 ipc-observer、增加 started/resolved/rejected 和真实响应延迟；seed 经真实引擎建立正文、任务与图片。不再沿“按钮没进入 React / SQLite 挂起”推断继续改产品。

实际修复全局通知动作三连点 3 次写→1 次写；受控 Dialog 无 Trigger 导致关闭原图焦点丢失；补可达历史帮助入口。原生单次激活验证 stop→archive、resume、editor；补真实 flush、原图、图片采纳回执与同一 WebContents 恢复。移除测试重复按键/替代关闭和空断言。

最终 Node239、类型/语法/构建/分块通过；原生七组196项按脚本累计全过；统一入口 quick+interaction-integrity 七步通过、complete=true、sourceChangedDuringRun=false。Python 本轮未重跑，后端无 Git 改动，715 沿用已验基线。未提交/推送/提版/打包。

报告 docs/迭代任务/Codex-交互专项独立验收与修复-2026-10-21.md；证据 .test-tmp/codex-interaction-audit-20261021/final-result.json。GLM 下一轮三批十二项见 GLM-后续工程与验收任务-2026-10-21.md：多专项独立播种编排、StrictMode 聚焦计时器与剩余编辑恢复边界。StrictMode 当前四项仅证明 useEventStream，不能称命令面板计时器已验；不触碰模型/迁移/安装高风险领域。

---

# 最新六批任务独立复验（2026-10-20，优先于下文）

已审查GLM六批30项并直接修复：错误标题/action/toast脱敏；真实TanStack刷新throwOnError与创建成功回执；慢刷新DOM移除观察；来源账号撤销及flush保护；验收脚本完整性、目录联接/所有权、显式注册表和退出码。新增PS5.1行为测试捕获并修复Get-FileHash启动链缺失及LASTEXITCODE作用域问题。

本轮实际Python715独立ID全过、Node233全过、类型/语法/构建/依赖图过；真实首次创作30、综合24、焦点5、四档宽度过。焦点5使用实际生产helper+合成DOM，完整真实列表键盘旅程尚需补；没有物理DPI/RAM/冻结安装结果。quick6全过，缺夹具/未知/缺依赖非零，人为失败子进程2总入口1。

没有打包、提版、推送，后端实现未改，保留全部未提交文件。实际E盘目录、HEAD4513985、beta.2。报告docs/迭代任务/Codex-六批任务复验与修复-2026-10-20.md，日志.test-tmp/codex-batch-acceptance。GLM下一轮docs/迭代任务/GLM-交互验收补齐任务-2026-10-20.md：4批16项交互原生测试/小修复；不要重做之前六批或高风险模型/迁移/安装领域。

---

# 最新组件整理落地（2026-10-20，续，优先于以下）

用户让我继续核对GLM是否全完成，并要求审查后提供GLM可继续任务。GLM新增仅是只读组件审计，代码未落地；本轮已实际拆ChatPane654→232行（MessageBubble/TurnProgress/CandidateHistory/Composer，组件体hash逐块证明纯搬移），独立modelBootstrap和保留访问身份的ModelSettingsHost，React运行时按Rolldown当前codeSplitting接口独立分块。入口584988→354410B，静态JS闭包597688→573966B，勿混称RAM或39%首屏减少。新增AST资产图工具、check:bundle命令与3个行为回归，28个JS/CSS引用无缺失/无远程引用。

修了CommandPalette焦点timer cleanup；发现并真实复现AgentActionCards generation恒0与非零refreshSignal比较导致轮询中断，已以cancelled生命周期守卫修复。专项用隔离DB真实事件序号1送达后改后台完成、不发完成事件，修复前失败后4/4过。冷加载观察最初PerformanceResourceTiming不可用，改Debugger.scriptParsed实际模块观察；失败记录保留。

最终类型/构建/Node212/资产检查过；综合原生24和轮询4最终源码过，拆分/加载优化后首次30/长会话30/配图27过。配图--images-only明确跳过真实TapNow站点，综合仍检查真实WebContentsView让位与同一ID恢复。首次出稿明确Mock，无真实云调用。既有197后端SHA未变，713基线沿用，未重跑完整Python。没有新ASAR/安装包/提版/推送。

详情docs/迭代任务/Codex-组件整理落实与验收-2026-10-20.md；用户可交给GLM的下一任务为GLM-后续执行任务-2026-10-20.md，6批30项多模块交互/样式/键盘/帮助/只读编排/回归细节，保留本机全部未提交改动，实际实现才能标完成。不要重复已完成拆分与分包，不把高风险Token/迁移/安装等塞给GLM。最终source/结果见docs/上线准备/completion-current.json；日志与失败记录在.test-tmp/glm-completion。

---

# 最新GLM独立验收与修复（2026-10-20）

GLM以4513985为基线交付了错误工具/帮助/窗口内查找，原始205 Node可复现；原报告多数沿用旧验收。Codex用独立2000消息夹具复现6项失败并修复：首次/下一命中定位、追尾与轮询保持、关闭焦点；纠正预算0仅会话不限制、Radix tab语义，补BrowserWorkspace帮助/备份/排期让位；RPC普通对象message/嵌入错误码和脱敏、真实MODEL_TIMEOUT等映射；补awaiting_user标签及原型键边界。新增使用帮助常驻入口、八步指南、按需加载和文档/贡献/测试导航。

最终Node209、类型/构建/桌面语法通过，新增源码Electron19项过，网页附加视图ID[2]在帮助关闭后不变；HTTP(S)全由夹具阻止，不能当TapNow站点或登录验收。既有长会话真实Electron30项用新夹具重跑通过。既有197后端文件SHA与713基线相同，本轮未重跑完整Python。无新包/提版/推送。构建仍有>500kB警告，不宣称全局分包或长期RAM完成。

完整报告docs/迭代任务/Codex-GLM验收与收尾-2026-10-20.md；可复验tests/seed_glm_review_native.py + desktop/tests/glm-review-native.cjs。最终新夹具fda5dcdb36ea；长会话4f91a5e646a9。JSON/截图/日志是本地忽略证据，Git克隆需重建。此前扩展浏览器测试有一次child数量断言错误（真实只有额外View为[2]），修正测试并保留失败，不隐去记录。

下一轮仍优先精确Token/窗口及大资料覆盖、真实供应商、旧checksum、长时浏览器大图RAM和完整冻结安装升级；不要把本轮称为54项全部完成或已正式发布。用户原先提供的AGENTS指令已在2026-10-20撤销，不再作为本轮适用规则；当前E盘工作目录偏好继续按用户既有选择。

---

# v2.0 HANDOFF

## 最新流式取消与网络内存（2026-10-18，优先于以下记录）

只用E盘。http_io.py全局按需一个I/O loop+至多2系统DNS/证书准备线程、最多2请求、队列2*16KiB，HTTPX异步+请求总时限，事件唤醒不固定睡眠；回调及SQLite留原调用线程。request_control ContextVar嵌套合并，Router._call包控制、Service.call包装_dispatch_call并绑定close，_app的engine.should_stop绑定consumerStop，close给chatEvent置位。MODEL_TIMEOUT不重试相同profile，只有配置回退；取消终止不回退。SSE字节块先限8MiB/事件2MiB，UTF8/跨行JSON一次扫描/usage，有界gzip/deflate。系统代理/NO_PROXY端口匹配保留、系统信任、无重定向。新增HTTPX0.28.1/HTTPCore1.0.9及冻结收集。

TLS首验失败并有Proactor未闭transport：HTTPCore AnyIOStream.start_tls只捕Exception，CancelledError是BaseException。http_backend.py用公开AsyncBaseTransport/AsyncNetworkBackend/AsyncNetworkStream扩展持有握手原TCP流，所有异常显式关闭并独立屏蔽取消，未改site-packages。最终19专项过，包括阻塞DNS调用方取消（OS解析线程不能强杀但至多2、不排队）、TLS实际SocketEOF、DesktopService stop/close/metadataGET、预算/回退、线程不增长、gzip等。老64/55组合有重叠不相加。

源码Electron首稿30过：fixture83110a182476/attempt83110a182476-1792303239940，仅1次明确Mock，Node197过。独立Windows网络冻结探针四模式过（0dc1e25d23ff，network-frozen.json+network-frozen-source.json，EXE SHA9c1da2dd…43507d），取消/TLS各328ms/总时限359ms为预热本地样本非SLA，active0/服务端断开/stderr空；不是最终桌面安装器。1989已消费exit0。

旧transport从Git+已验收补丁重建，SHA536ee822…b03e与generation-source-current精确匹配，network-baseline-transport.py；独立16MiB异常SSE进程峰值34076687→2621730B，125→94ms，当前更早拒绝不是同样读完字节；非总RAM/云速率。最早队列轮询版1000ms原记录保留，现事件唤醒。network-memory.json有当前3模块SHA，最终根aede6cfeb2b5。最终713独立后端全绿172.219秒，无失败/错误/跳过/重复/source_changes；197当前文件、冻结源和内存3模块一致（network-source-current.json）。34807已消费exit0；旧694存full-before-network-control-*。清理29043也已消费exit0：本轮full0fdb8de8e44c与冻结work精确删4530文件721539620B逻辑大小，原生/EXE/个人选择SHA保留；owned-fixture-cleanup-network.json及network-cleanup-checked.json独立核对。没有活跃全量/冻结/清理句柄，不重复等待。完整报告流式取消与网络内存-2026-10-18.md。整体goal active，下一步输入Token精确门/云质量/复杂代理、浏览器大图总RAM、6checksum、完整桌面冻结安装仍待继续，无新桌面包/提交/推送。

## 最新模型窗口与输出控制（2026-10-18，优先于以下记录）

只用E盘。新增llm/limits.py，profile.extra.model_window绑定base_url/model_id，GET/models唯一ID提取整数窗口/输出和时间，未知/重复不猜；limits_hash CAS含身份与extra。models.limits_save/window_refresh严格当前账号，网络前后复核设置revision，改模型或端点清旧窗口和输出。所有生产适配器把extra.max_output_tokens显式传max_tokens，None不传；Router._call预算前校验，快照保留。UI每供应商输出与窗口，独立dirty/关闭/导航保护、冲突保留/显式载入。模型目录重操作归后台；Transport目录2MB/10000行、错误64KiB关闭、不重定向/不回显Key、端点禁嵌入凭据/query/fragment。

15独立专项、之前48相关组合（重叠）、Node197/最终类型构建、最终源码Electron11通过；最终fixture91be9f258d3c、attempt91be9f258d3c-1792301665397，窗口元数据为夹具预置，真实点击读取按钮通过保留.invalid域名验DNS失败反馈/未知不覆盖，无IPC注入/云调用；后端真实回环GET→设置→生产Qwen POST max_tokens2048/账本0→1另验。最初10项fixture155298c9ddeb仍保留，Native session57740已消费exit0。最终694独立后端回归全绿211.844秒，无失败/错误/跳过/重复/source_changes，193文件当前SHA一致（generation-source-current.json），10227已消费exit0。旧679成功存full-before-generation-*。本轮full ff4893c96bc1已精确清理4503文件704682654B逻辑大小，6857已消费exit0；owned-fixture-cleanup-generation.json与generation-cleanup-checked.json确认目录不存在/最终原生保留/个人选择SHA未变。没有活跃全量或清理句柄，不重复等待。详见模型窗口与输出控制-2026-10-18.md。输入Token精确计数/输出预留门仍未实现，不拿窗口显示冒充；下一步对应模型版本/模板/图片分词口径、更大资料分批、真实云质量、长时RAM、6旧checksum与完整冻结桌面安装。另需检查SSE读取是否在单行分配前真正执行大小上限及取消/总时限，勿只看解析后8MB检查就当传输内存有界。整体goal active，无包/提交/推送。

## 最新长历史模型输入批次（2026-10-18，优先于以下记录）

只用E盘。修上一批1500历史对象超180k直接不能出稿：llm/context.py对history/article_history.known_titles已知五字段且>=16条编码title-table/v1，保留每个值/顺序/hash；五篇全文、领域对象/公开API/确认hash/内部req.context不改。未知新字段回原对象防丢失。request_messages统一system/history/prompt/context/schema，真实文本总长180000保护也覆盖repair，_call在reserve之前拒绝，不假称Token窗口。JSON字面关闭context标签转义后解码原样。创作消息input_manifest有初始实际request_hash/字符/字节/历史来源counts与hash，新UI可展开写作依据。

新增10独立专项、Node197、tsc/build过；源码Electron11（context-native.json，fixture cb38e9327629，attempt cb38e9327629-1792300401996）确认1491/标题→实际Router+Mock出稿→保存无job/审批，1500全标题/五全文，完整初始请求149261字符/263696B，1280/800无溢出。另真实回环HTTP/SSE五项：400窗口不足→已配置DeepSeek回退，全部消息hash一致、1501标题含新草稿/五全文；ledger独立protocol.db，服务线程已结束，无外网或真Key。

首次679终态183.843s，仅test_publications配色sample_count的JSON空格字符串断言失败，已归档failed-679-context-spacing。改为解析实传JSON核对sample_count和全部三种实测色值，11相关过后最终679全绿194.641s，无失败/错误/跳过/重复/source_changes，当前190源码SHA相同。41177已消费exit0、52946已消费exit1。cleanup-context-fixtures.ps1已完成两个专属full目录删除（4c71a94c3da8/f9ec23772dc5，8932文件1380704211B逻辑大小），97650已消费exit0；owned-fixture-cleanup-context.json及context-cleanup-checked.json独立确认删除/原生保留/个人选择SHA未变。没有活跃测试或清理句柄，不要重复启动它们。context原生样本与protocol.db保留。完整报告长历史模型输入与出稿-2026-10-18.md。下一轮先按实际端点/模型接窗口元数据/Token口径与输出预留（官方GET /models可返回DeepSeek窗口，详报告源链接，不硬编码别名），更大资料分批覆盖、真实云质量、浏览器/大图长期RAM、6旧checksum与完整冻结桌面/安装升级仍需继续，goal active，无新包或推送。

## 最新后台分页与历史内存批次（2026-10-18，优先于以下记录）

仅用E盘。outlines.list/history.list显式page_size启用SQL分页/标题期号搜索，历史还支持status/include_unclassified；旧无page_size形状兼容。精确EditorialTopics.get/match/update；新match include_available:false只当前与下一期；新保存return_rows:false不回整表。base_hash流式编码保持原canonical JSON字节/hash。历史元数据、文章/草稿索引、iter_library_entries按行；context只保留当前栏目元数据，再get五个先前不同期全文，完整模型标题和context_hash不变。history.get和创作历史引用改精确get。新UI模型摘要include_titles:false只省全标题传输，仍有总数/全文/hash；模型默认全标题不裁剪。真正10条后台翻页、200ms搜索合并、状态筛选、单篇只读预览；翻页refresh:false不重扫文件，主动刷新先同步；自动期号回填不重读同一历史。

最终669独立后端全绿219.297秒，0失败/错误/跳过/重复/source_changes，187当前源码一致（paging-source-current.json）；45362已消费exit0。Node197、最终类型/构建、大目录真实Electron20（paging-native.json，22b22f7527ab-1792299526853）和旧选题全旅程31（editorial-native.json，592c2562ebfe-1792299579685）过。前者仅观察IPC不注入参数/回应，无云调用；后者仍明确离线Mock/文件选择器注入，非供应商/物理OS验收。两份最终fixture都保留。

性能：保存改动前publication_history.py到docs/上线准备/paging-baseline-publication-history.py，SHA037640b14832f3f74230660ca1cd7c7d620d1165c1944fc5884b0edbb8127d0b。独立进程1500长正文完整历史对象响应339379B/结果SHA完全相同、1500标题/五全文，Python tracemalloc峰值32883484→2639952B；当前UI摘要151528B。2001大纲legacy11262825B→本栏10条57012B；原生页最大56800/历史3609B。都是样本Python分配/传输指标，不是整机RAM/SLA。实测详见paging-memory.json、后台分页与历史内存-2026-10-18.md。

**下一轮先处理已证实的P1功能边界**：paging-context-boundary.json中同一1500篇完整history对象227259字符，本身就超过creative_chat.send对整个context的180000字符门；该规模直接出稿会被拒绝，不能拿本批对象比对当实际模型出稿验收。应在保持全部标题/身份/前五全文、hash及审批规则的前提下，设计紧凑LLM上下文表示并按模型窗口处理，实际Router/离线生成验证，再真实供应商。不要直接撤掉180k门或静默裁剪题目。这是后端分页之后真实发现的下一步，不要跳回只做UI。之后继续浏览器大图总RAM、旧checksum、完整冻结桌面新装/覆盖升级。

当前full-tests为669，旧658存full-before-paging-*。完整专属01520f3e7b0e已按owner/精确路径/无reparse/无活跃引用/非个人选择清理，4458文件594538953B；owned-fixture-cleanup-paging.json finished，paging-cleanup-checked.json再核对两最终样本/个人记录保留，49403已消费exit0。所有本轮句柄终态，勿再等45362/30277/49403；不复用已清理full runtime。没有新安装器/提交/推送，完整goal仍active。

## 最新选题排期与会话交接批次（2026-10-18，优先于以下记录）

仅用E盘。新UI EditorialHost lazy，左栏/指南/命令面板入口。当前栏目默认已发布+1、前五个不同期号完整正文/全部历史标题计数、手选1–9999；MD/TXT/DOCX读取、解析后8条分页修改/保留与显式覆盖，已存题10条翻页与搜索、发布状态/日期/快速进度。未确认修改保护关闭/Esc/全局切换；确认后只带入Composer，不自动模型/不建job。选第100期预告只用本栏目101或显式预告，不误用旧页面12。

chat.create新增editorial_plan={plan_id,confirmation_hash}；从publication_plans服务端读取确认字段/标题来源，校验账号/栏目/历史/大纲hash，以target_json保存确认快照。幂等hash含计划身份，同请求重试取原会话；网络失败保留确认和request_id。send以固定期号读取前五篇+所有标题，锁定的初稿标题与H1统一，不改代码围栏。保存后沿既有草稿/人工审核流程，series/episode元数据正确。历史读写加显式账号保护，进度context_hash在事务中CAS，确认标题拒绝CR/LF/NUL。

最终658独立后端全绿166.313秒，0失败/错误/跳过/重复，source_changes=[]，183当前源码一致；74285已消费exit0。Node197（新增5）、最终tsc/build过；真实Electron31项（editorial-native.json，b70671fc1807-1792298661785）过，70历史/26题/100期→实际Mock初稿→保存草稿→日期拒绝/登记70/下一期71均验。**只有明确离线Mock；文件选择器注入，不是云质量或物理OS对话框验收。** 1026题预热后12次开关V8堆+230212B，DOM340/监听343不增加；不是整机RAM证明。

当前full-tests为658；648存full-before-editorial-*。完整专属9c9b7a8424ed与旧原生d93857e116ae/f45b529fe1eb已按owner/精确路径/无reparse/无活跃引用/非个人选择清理，3目录609699355B，owned-fixture-cleanup-editorial.json finished，editorial-cleanup-checked.json再核对通过；75470已exit0。最终b70671fc1807、截图和个人资料保留。所有本轮句柄均终态，勿再等74285/7004/75470，不复用已清理full runtime。

构建入口513816B而静态JS闭包569193B（editorial-bundle-analysis.json），共享client/toast归并的单块警告如实保留，排期模块未在启动闭包；不要只拿入口大小说RAM/加载变好或变坏。后台outlines.list仍全量元数据，此批仅DOM分页/卸载释放。下轮优先后台大纲分页/精准期题与历史搜索，再真实供应商延迟/质量、浏览器大图长期RAM、旧checksum，最终完整冻结桌面新装/覆盖升级。没有新安装器/提交/推送，完整goal仍active。报告docs/上线准备/选题排期与会话交接-2026-10-18.md。

## 最新备份恢复与任务接续批次（2026-10-18，优先于以下记录）

继续仅用E盘。新UI左下与命令面板备份入口、lazy面板、完整回执/预览确认/忙碌状态/复制、关闭重开保留恢复路径、下次目录切换失败单独重试、顶部暂停任务提示。backup.py媒体/DB分块1MiB；预览在E盘临时DB实际 integrity_check/迁移/品牌和模型结构/检查点hash，不改原工作台。BackupActions主进程picker+10分钟token+互斥/单次恢复/原子选择记录，raw backup.create/restore未开放普通RPC；新backup.queue/resume_queue账号+指纹+状态校验。恢复时任务payload路径+canonical_input_hash迁移，未完成队列RESTORE_REVIEW暂停，待取消变cancelled；worker对账不得自动重排、认领与备份共享guard，显式继续复用job。备份时阻断正在运行的创作回复/工作流/队列。新UI凭据警告不再调用不存在的旧toast。

最终648独立后端全绿197.375秒，无失败/错误/跳过/重复/source_changes，181文件当前一致；19651已消费exit0。Node192、专项42、最终tsc/build/desktop脚本、Electron28项通过；原生11777已消费exit0，最终fixture 8ec72a76afde，attempt8ec72a76afde-1792297463840。实际重启后正文/工作稿/原图保留，未确认项不启动，点击继续到succeeded且另一项paused、没有重复job。**系统picker注入，个人目录指针重定向，不能称Windows物理对话框人工验收**。没有真实Key/云调用。详细docs/上线准备/备份恢复与任务接续-2026-10-18.md。

旧633存full-before-backup-*；第一次647中2个旧手工配置夹具缺active/routes/brand错误已归档failed-647-backup-fixtures-2026-10-18，现改真实DesktopService配置，原有断言保留。当前full-tests为648成功，勿误用647或再次等其终态旧23009；该旧handle已消费exit1。没有新安装器/提交/推送，完整goal active。下一轮继续历史拟题/预设大纲完整旅程、供应商延迟故障、浏览器/高像素图片长时RAM、旧checksum过渡样本，最终完整冻结桌面新装/覆盖升级。

本轮清理owned-fixture-cleanup-backup.json finished：两轮full+四轮旧native共6目录1221619439B已删，77735已消费exit0；再核对backup-cleanup-checked.json通过。最终8ec72a76afde与个人目录保留；19651成功full runtime b8fa6975a262和647失败ee0e8112e5cf已清理，不再用这些目录运行。所有当前测试句柄已终态，无需等待。

## 最新长会话与内存批次（2026-10-18，优先于以下记录）

继续只用E盘。chat.get默认仍兼容旧完整响应；新UI传message_limit40/candidate_limit3，before/after身份游标按会话校验、反向读取稳定，返回message_page/candidate_page。新UI历史消息和候选可双向翻页，固定当前阅读快照、实时尾页独立轮询，新回复不挤掉正在读的首行；现有TanStack虚拟渲染测量、gcTime0释放历史页。正文复制、历史稿保存/审阅、输入恢复和宽/高独立改变仍可用；滚动意图只在已有可滚动消息记录并即时消费，测量/viewport ResizeObserver不误停跟随。

633独立后端全绿145.922秒，source_changes=[]，当前179文件一致；Node181、最终类型/构建过。最终Electron长会话30（chat-window-native.json，attempt bd530759222d-1792295676105）、首次出稿30（beae45d21cb9-1792295806609，唯一1次明确Mock）、40会话7200事件资源回归通过。样本2000消息/120候选JSON37478266→759231B；十页后堆+1011576B、所属树工作集约465MiB，多会话预热后+270892B。内存采样按进程创建时间排除PID重用误算的旧其他应用；首次无效数据不可引用，不能宣称整机RAM下降98%。详见docs/上线准备/长会话与内存-2026-10-18.md。

旧627存full-before-chat-window-*。全量专属e3f4b7981213和过期长会话样本已按路径/owner/无reparse/无活跃引用安全清理834559238B，audit finished；最终bd530759222d、当前onboarding/resource、个人副本与报告截图保留。所有本轮检查终态，81235/22137/37224/78066已消费exit0，无需等待。没有新安装器/提交/推送，完整目标active。

下一轮：历史消息搜索定位和分页可访问性、真实供应商/延迟故障、浏览器/大图长期内存、备份恢复/历史迁移异常、物理目录工具和完整冻结桌面新装/覆盖升级。后台模型上下文没有被本次UI分页裁剪；不要把旧经典客户端全量兼容模式当成新UI已经回退。

## 最新首次创作与模型分工批次（2026-10-16，优先于以下记录）

真实发现仅配Kimi/GLM等Key却没进writer链仍显示就绪；现在写作主/回退链决定ready/untested/unrouted/missing。新models.routes_save显式账号+routes_hash，六文字角色原子更新，不写模型ID/预算/视觉；旧任务在WorkflowEngine.run还原原快照。新UI独立/统一角色选择、脏选择保留与关闭/载入保护，说明全局范围。开始指南可从左栏/命令面板返回，深链新增/历史，按账号保留初次要求；新建会话带栏目及初始输入，单槽内存交接支持StrictMode和存储故障，只预填不发送。

最终627独立后端全绿（146.015秒，source_changes=[]，当前177文件一致），58424/60232已消费exit0。Node179、类型/最终构建通过；首稿30项Electron（onboarding-native.json，attempt d70edce82104-1792134547687），预算31和窄窗40回归过（79838/27812也已exit0）。首稿是实际引擎/真实IPC/SQLite链路，但唯一模型调用明确为Mock，夹具假Key只给Mock，无真实云调用，不能宣称供应商文章质量通过。源码入口309.35KB不代表进程内存。

旧620存full-before-onboarding-full-*。Full627专属8d1c719523be已删除4269文件/529627330B，报告/样本/个人副本保留；原清理Split-Path参数组合报错（非终止）如实记录，随后用IO.Path准确复核只删本轮预期目录，没有再删除其他文件，见owned-fixture-cleanup-onboarding.json。不要复用该已清理runtime，也不要等待已终态旧句柄。

下一轮优先解决chat.get每8秒全量加载单会话所有消息/候选及Markdown全渲染，保留完整历史/复制/滚动位置/实时输出，做真实长会话进程RAM；再大图、备份/迁移异常矩阵、系统对话框工具与完整冻结桌面安装升级。没有新安装包/提交/推送，目标active。

## 最新窄窗口与专注写作批次（2026-10-16，优先于以下记录）

只用E盘。WorkbenchShell新增常驻布局工具条；小于1080px在导航/写作/任务之间单面板切换，大窗独立收起并保存选择，专注恢复保留原组合。所有面板保持挂载，hidden+inert避免隐藏焦点，导航key变化回中心；真实同一DOM、未发送文本/未保存正文/草稿、Esc和Tab、损坏与失败存储均验证。PaneActivity让LeftNav/RightPane/DownloadStaging隐藏时暂停列表query，不取消后台任务。观察21.5秒四类IPC增量均0，重新打开恢复且读到新会话。

最终Electron40项全绿，layout-native.json，attempt d919feb8322d-1792133263502；34474已消费exit0。Node175（含布局9）、最终tsc/build通过。夹具包装器只观察IPC方法名，不修改请求/结果/授权。入口298.32KB不是总RAM指标。上一批次Python620为后端基线，本轮仅新增seed，无生产Python变化，未再跑620。详见docs/上线准备/窄窗口与专注写作-2026-10-16.md。

下一轮：首次使用/通用公众号与历史导入到首次出稿闭环；长会话和整桌面进程RAM/大图；旧checksum与备份故障；真实系统目录工具与完整冻结桌面新装/覆盖升级。所有本轮测试已终态，勿再等待旧session。没有新安装器/提交/推送，个人数据未改，目标active。

## 最新完整交付批次（2026-10-16，优先于以下记录）

继续只用E盘。完整交付源码已补：CommonMark纯文本/图位与运行输出展开、RUN_REF实际文字校验、未知图位/普通图片门、运行中与版本绑定、审阅hash加入证据、事实来源注解共用及按文章隔离ID、后台导出不占stdin、流式hash/确定换行、取消/缺项/路径与成功目录回执。依赖markdown-it-py4.2.0/mdurl0.1.2已安装并声明，构建收集已更新。详见docs/上线准备/完整交付与导出-2026-10-16.md。

最终620独立后端全绿，138.375秒，source_changes=[]，当前174文件再核对一致；11673已消费exit0。Node172、类型/构建、Electron34项（export-native.json，attempt847aef820d35-1792131958119）、独立冻结EXE实际导出7项（export-frozen.json，当前runtime d8480ad9cdfd）通过。冻结引擎在.test-tmp/release-export-freeze/a7f09c11443e/dist，EXE SHA256 dedf591689ba4407538bdf7c331abc10384160913fdd00153530a5503df1ffef。68225构建、23983/69035复验及37323清理等全部已终态，无需等待。冻结样本只用系统PATH、清解释器/Key环境；无真实云请求。

**系统目录/shell结果明确由隔离测试主进程包装器注入，不是Windows物理UI实测**。computer-use按skill尝试node_repl初始化，错误267，重置后仍失败；G旧目录不存在，完整根因未证。不得改用PowerShell UIA假称已验，不重建G作为默认运行位置。没有给发行main加测试跳过批准开关。

615/618中间成功归档，当前full-tests为620。三轮对应专属目录7b7b6e44bafb/3c4ddcc1efa5/17df7611b50b已owner/路径/祖先子项无reparse/无进程引用核验后清理（12738文件/1564662117B，owned-fixture-cleanup-delivery.json三项deleted=true），报告与导出/冻结样本保留。其他用户数据未动，不继续依赖这些已清理runtime。

下步优先通用首次使用及导入历史到首次出稿、窄窗口侧栏/长会话；继续预设题目/发布进度、代码纠错/重试、整体RAM/高像素压力、历史checksum与备份故障，最后真实目录选择及完整冻结桌面新装/覆盖升级。旧审阅hash因纳入运行证据可能需要重新确认；旧共享来源若非本篇证据需重新核验，不清原文/数据。不把引擎单独EXE当安装器。未生成新安装器/提交/推送，长期目标active。

## 最新预算批次（2026-10-16，优先于下面历史）

全局预算三项现位于新UI设置顶部，可改且有未保存/导航/关闭保护；保存模型ID独立于探测，新Key未存禁止旧Key探测。后台读配置不盖输入，预算CAS与模型ID/账号校验拒绝旧窗；旧经典调用不带chat字段时保留当前值，避免重置24。详见docs/上线准备/全局预算与模型设置-2026-10-16.md。

完整601独立后端回归、零重复/失败/错误/跳过、131.391秒、source_changes=[]，96267已消费exit0。Node167、最终类型/构建、真实设置旅程31项过（budget-native.json，目录98d0484f170a-1792128731826），旧596归档full-before-default-budget-*。77626首版复验已exit1消费（漏点击），最后带实际事件到达确认的新夹具exit0；无活跃检查，不继续等旧句柄。原生计数为3条植入账本+两次工作流Mock调用，设置未新增模型请求，Key是独立目录中的无效夹具。

601全量fixture bb824f23430b已核验后清理（4218文件/516886732B），owned-fixture-cleanup-601.json deleted=true；报告、原生夹具和个人资料保留，不再期待该runtime存在。

未打包/推送/真实供应商计费。下一轮优先ready审批到MD/TXT+图片及系统目录导出，再首次使用引导；仍需角色/视觉高级设置、预设题目/发布进度、长会话/代码纠错、通知重排/长延迟、全桌面RAM、历史checksum/备份故障与冻结新装覆盖升级。完整目标保持active。

## 最新接续：公众号设置与弹窗交互（2026-10-16，优先于以下历史记录）

继续只用E盘。新增通用公众号配置：JSON/MD/TXT预览后编辑保存、品牌/栏目/目录、历史搜索分页、CAS拒绝旧资料、创建幂等和三账号免重载切换。鼠标验收发现通知盖保存并触发Radix外部关闭，现通知随顶层Dialog布局/生命周期；冲突后恢复入口改常驻。详见docs/上线准备/公众号配置与弹窗交互-2026-10-16.md。

最终596独立后端回归、零重复/失败/错误/跳过、144.485秒、source_changes=[]；14347已消费exit0。Node162、最终类型/构建/IPC脚本、公众号真实桌面27项、共用配图/内嵌网页33项通过。旧591保留full-before-publication-settings-*。本批次所有检查已终态，无须轮询48892/70822或更早句柄。

596全量fixture `6ff76eaa8451`已核固定路径/owner/无reparse/无进程引用后清理，4201文件/511067145B；owned-fixture-cleanup-596.json deleted=true。报告与截图留存，原生夹具和个人数据保留。

未打包/推送/真实Key计费。下步优先全局普通文章/补图预算编辑及未保存保护、ready完整导出/系统目录选择、通用首次使用引导和发布进度/预设题目。仍需长会话、代码纠错/重试、全桌面RAM与高像素、历史checksum/备份故障、冻结包新装/覆盖升级。原生夹具与测试生成物在E盘.test-tmp专属子目录，清理只能逐个核owner/路径/无reparse/完成且无占用，不泛删个人runtime、文章或旧G目录。长期目标active，不能当作已上线。

## 2026-10-15 交互迭代（当前源码，未打包/推送）

- 基线 main `6fcca5a` / beta.2；本轮仅改新工作台前端与测试，不改迁移或后端门控。
- 新增安全Markdown阅读（标题/列表/代码/表格、复制、按需加载）、会话头部重命名、回到最新与真实未读提示。
- 输入+创作模式按账户/会话在本地恢复；旧消息再次使用不覆盖现有输入；IME、迟到回执、保存/停止失败有保护与反馈。
- 草稿箱增加排版/源码预览、全文复制、搜索草稿和失败重试。
- Node123/123、TS/Vite通过；真实Electron17项检查全部通过，含缓存未读、刷新恢复及1280/1024/800无横向溢出。入口chunk498.32KB。
- 证据、调研和边界：`docs/交互迭代-2026-10-15/迭代报告.md`。现有发行包未变；没有真实云生成/发布或安装覆盖测试。

---

更新时间：2026-10-11（B/C1/C2/C3/D 完成，未打包、未提交）

```text
当前基线/应用版本/协议/schema：
  发行包：release/ICE-Loop-Studio-2.0.0-beta.2-{Setup.exe,x64.zip}
  SQLite MAX_KNOWN_VERSION=19（v19 运行截图溯源 capture_assets）；契约层 PROTOCOL_VERSION=2
  版本同步：desktop=2.0.0-beta.2 / ui=2.0.0-beta.2 / pyproject=2.0.0-beta.2 / __version__=2.0.0-beta.2
当前阶段：
  验收 R01–R16 全部有修复+回归（部分标注详见修复批次报告）。
  全量 Python 497/497 独立 ID、Node 90/90、beta.2 EXE 三路 smoke 全绿。
  批次A 队列生产接线完成；批次B 核心完成；C3 假费用修正；D ContextPack 确认在。
剩余待做（如实）：
  迁移/冻结专项（任务单第 7 节）未动；未打 beta.3 包
  C2 仍部分：资源箱放大/原图查看沿用既有资源预览，未在新 UI 重做；
  TapNow 固定站点入口与各公众号独立登录沿用 browser.cjs，未改
  截图失效提示目前经 assets.capture_status 返回 stale，新 UI 尚未单独展示该状态
已完成（beta.2 之后）：主包分包——启动包 1136 KB → 337 KB（index 286 + client 51）；
  编辑器 648 KB 与流程图 178 KB 改为按需加载（点"编辑正文"/展开状态图时才下载）
  新工作台前端第二轮：富文本模式下正文溢出盖住"修改提案"的布局 bug 已修；改稿审阅改为字符级差异
  （inlineDiff.ts）；命令面板分组/新建会话；左栏最近/归档/回收站分段与时间；知识检索引用切换；
  行动卡自适应轮询；分栏计算抽到 paneLayout.ts（中等宽度优先保中栏 480px）。Node 测试 102 项
  发行可用性一轮（2026-10-11，未打包）：
    默认启动新工作台；选择存 runtime/ui-preference.json，双向一键切换（经典顶栏"新工作台"/
    新界面左栏底部与命令面板"经典界面"，IPC ice:switch-ui / ice:relaunch）；
    --classic-ui / --new-ui 强制；依赖 window.__ICE_*__ 的冒烟固定走经典页；ui/dist 缺失回落经典。
    选择逻辑在 ui-mode.cjs（已加入 electron-builder files），tests/ui-mode.test.cjs 覆盖
    新界面内补齐"模型与 Key"设置（保存 Key/测试连接/正文使用标记，Ctrl+,）、欢迎引导页
    （未配置/未测试横幅、快捷入口）、引擎退出横幅+重启、credential_warning 改由 bootstrap 提示
    交互动效：全局 toast（可撤销归档/删除）、对话框进出场、骨架屏、消息入场与流式光标/打字点、
    分段控件滑块、列表增删布局动画、行动卡展开收起；prefers-reduced-motion 全部关闭
    Node 107/107、ui-smoke、dpi-smoke（1/1.25/1.5/2 无横向溢出）通过；启动包 index ≈ 488 KB
    （motion 进主包，gzip 153 KB）
待办完成一轮（2026-10-11，未打包、未提交、未动 release/ 与用户工作区）：
  B 最终交付审阅：articles.delivery_snapshot / delivery_confirm，审阅哈希与 ready 导出对齐；
    新 UI 交付审阅对话框（阻断项、图位、规则、声明、确认后导出）
  C1 事件进度：创作会话与工具循环把真实步骤写入 stream_events（chat:{会话}），
    新 UI 按账号|流缓存游标、分页补缺、去重；生成中显示真实步骤与已用时间，
    不再把 progress 对象直接渲染；turn.finished 立即刷新会话，工具事件立即刷新行动卡
  C2 下载归档：内嵌浏览器下载完成后进 download_staging（不默认采纳），
    新 UI 待归档箱选文章与图位后 downloads.bind，或判定不采用；
    同内容重复下载复用原记录；运行截图登记 capture_assets（账户/任务/图位/运行/源码 hash），
    运行证据变化后 capture_status 返回 stale；顺手补上 bind_download 缺失的 find_slot_for_figure 导入
  C3 预算面板：budgets.get 增会话已用/剩余与是否显式配置；0 为显式不限制，未配置按默认 24；
    新 UI 模型设置内展示全局/补图/会话/当前会话，保存走 budgets.save；
    发送遇"模型调用已达上限"给出打开预算设置的入口；计数仍由后端账本执行
  D 摘要注入：chat.summary 只覆盖较早轮次（最近 6 条留原文）；请求构建时按账号重读摘要，
    范围不符或内容 hash 不符则标记失效并退回原文；覆盖范围与 hash 写入消息 summary_manifest
  验证：Python 全量 520 通过；Node 113 通过；tsc 与 vite build 通过；
    ui-smoke、dpi-smoke（1/1.25/1.5/2 无横向溢出）通过；
    模拟桥接视觉检查覆盖预算面板、真实步骤进度、待归档箱，无控制台错误
回退方案：1.5.3/beta.1/beta.2 包均保留于 release/；新版 schema(v19) 拒旧引擎
下一步：迁移/冻结专项；再打 beta.3 前重跑全量+EXE 旅程
```

## 2026-10-15 持续上线准备（未完成目标、未打包）

用户已确认定位为**通用Windows桌面版**，本地数据、多公众号导入与模型配置。
持续目标与证据位于`docs/上线准备/`，先读`task_plan.md`和`阶段进展报告-2026-10-15.md`。

- 修复后台任务按原账号/冻结规则恢复、审批恢复缺失import、Future回收及取消回调锁重入。
- 实际40会话/7200事件内存实验发现并修复Query闭包保留；渲染器JS堆约25.08→11.10MiB，热身后20→40会话增约0.40MiB。总进程工作集约438.75MiB，勿将JS堆声称总RAM。
- 编辑器写入串行、保存时继续输入不覆盖、CodeMirror恢复同步、空恢复稿可保存与恢复（正式正文仍拒空）、同文新基线更新；主次操作栏分行，保存固定右侧。
- 后端全量基线529/529通过（零跳过、唯一ID）；之后编辑补丁专项14/14；Node134/134；tsc/build；原生对话17项及原生编辑17项通过。
- 7历史测试库的只读来源副本升级16/17→19，核心行hash保留；6份旧checksum审计仍有告警，仅v10/v11精确匹配Git早期算法，不能全忽略。
- 下一批先处理队列长步骤租约/取消/重启、长会话，再做完整资产导出及独立beta.3冻结发行验收。旧beta.2不含当前源码修复。全目标保持active。

随后队列迭代已落地：可恢复paused/等待/取消状态一致、持续心跳与引擎协作停止、失租保护、原子建稿绑定、重启恢复、真实审批续接；新Agent入口不接受无消费者任务或模型伪造的批准/目录/历史，继承预算并补连接关闭。93项相关回归及末次跨号3项、Node134、原生19项、3次应用启动通过。首次原生退出未定位，保留失败并补退出码日志。

560独立ID全量已全部通过，旧session87736已消费exit0；证据归档full-before-cancellation.*。旧自建fixture818eb2ce3fcd及随后ad3c37758e2d均已精确清理，两个独立owned-fixture-cleanup*.json为deleted=true；29729与79135均已终态，不再等待。

随后补齐新工作台四个人审门、候选保存/选择/修改、旧hash保护与关闭/导航保护；实际源码、输入、预期报错审批，真实输出显示及运行中暂停。原生最终26/26过（启动2620ms、停止1894ms），Node140/140、tsc/build过。新面板按需加载，继续使用Radix/Motion。CodeRunner接上任务停止回调，取消实际进程树、保留部分输出和取消证据，不当作预期报错通过；Java/Docker准备阶段及未启动边界一起覆盖，取消专项9/9过。真实Docker尚未实测。

原生最终复验曾在并行清理期30秒未发现target，未定位根因；保留失败并增加启动阶段诊断，同fixture随后26项通过。不要将重试通过写成已修复启动根因。原生每轮证据以后存workflow-review-attempts/<fixture>/。

**最新569独立ID全量已通过，零重复/失败/错误/跳过；原session49834已消费exit0，勿再轮询或重启。** runtime `.test-tmp/release-full/ecb7e60ed05e`暂保留；不泛清理。旧beta.2不包含这些源码更新。

本轮新增新UI文章配图工作台/原图查看器/原生网页工作台；交付审阅能跳到具体图位，真实截图/候选审核/否决/资源搜索分页/提示词保存/本篇预算直接操作。修Blob CSP、Portal延迟挂载空ref、原图适应窗口滚动条反馈。Node149/149、tsc/build、配图原生31项通过（assets-attempts/a97971a106cd-1792063188268，启动3494ms）。TapNow只测试匿名网页视图/无IPC/Node/区域尺寸/收缩/关闭释放，无登录或付费生图；所有图片/文章为G盘隔离夹具。

共享界面改动后重跑editor-native，首轮空恢复稿断言未等实际异步导航，观察时还在编辑页；保留editor-native-after-assets-before-nav-wait.json，改测试等待编辑器实际卸载后，最终19项通过（editor-native-after-assets.*），58135已消费exit0。未因此改产品保存逻辑。

接续先读task_plan.md和《配图与内嵌网页迭代-2026-10-15.md》。优先图片读取并发/卸载取消与大图压力，再旧队列raw spec批准/路径升级；完整导出/多账号/品牌/AI晚响应、历史checksum和备份、启动诊断、独立冻结安装仍未证明。全目标active，未打包或推送当前修改。

最新接续见《图片内存与旧任务兼容-2026-10-15.md》：图片RPC共用串行/原图优先/离开撤销队列，缩略图不进Query缓存，全部Blob关闭回收；后台纯图片解码门不跨DB/网络。六张4.32MP实际预览私有提交峰值约364→73MiB、234→485ms且字节SHA一致（非整个桌面RAM）。Node154、tsc/build、配图原生32项通过。

未绑定旧队列raw spec按服务端账号/目录/历史/执行策略归一化但不改幂等payload；已绑定旧任务也接入兼容。新job.desktop_context记录写入既有持久事件、与建稿/绑定同事务；旧宽泛批准清除、有效代码/input哈希批准保留，旧文件不删除不移动，无可信记录时未来输出采用当前账号配置。有记录后按冻结目录恢复；消费者也走_job_app。日常元数据轮询无额外正文decode/写锁。最终专项10项、之前相关30项过，最后补丁后工作流原生26项过（48186已exit0，暂停509ms）。不要把重叠专项相加充作独立总数。

**最新全量586唯一ID、零重复，session86479正在运行，runtime .test-tmp/release-full/7e4507e65e38，勿重复启动；源码冻结ice_agent/tests/profiles直到结束。full-tests.*为本轮进行中的结果，569成功已归档full-before-image-policy.*。** 脚本新增前后源码manifest和source_changes，必须消费终态并核对实际失败/跳过及源码一致后才可写通过。旧569 fixture ecb7e60ed05e暂保留，不泛删。后续完整导出/品牌/多账号/备份/长会话/冻结安装等仍需继续，目标active、未打包或推送。

## 2026-10-16 新工作区接续（优先于上面的历史句柄）

当前工作目录已按用户要求迁至`E:\Ice-agent\gonzhonhao`，应用在其wechat_agent/ice-loop-agent；后续所有操作用E盘。旧86479已不存在，无对应Python检查进程，中断586未完成，已留interrupted-586-2026-10-16，勿继续等待。虚拟环境base_prefix与激活脚本已修为E；内置profile默认相对路径与无关cwd启动已验。

备份恢复新增job.desktop_context_relocated并使用最新记录，保留原审计，防恢复后又指向旧根。源目录实际离线后读图/同job继续/MD+TXT图片相对路径/再备份再恢复已验。首次591发现旧取消fixture宽泛boolean及原生review上下文、旧提示匹配、外号检查顺序问题；保留失败并修复。56相关复验通过，未放宽权限。

**最终591唯一ID全量成功，零失败/错误/跳过/重复，source_changes=[]，126.329秒，58113已消费exit0；69707首次失败exit1也已消费。没有活跃全量进程。** full-tests.*是最终591结果，runtime .test-tmp/release-full/0e688d0dc5e9；Node154、tsc/build、E盘配图原生33项通过（22914终态）。资料详见《迁移接续-2026-10-16.md》。

复制来的日常数据原schema11（2文章/2任务/2资产）保持不变，在`.desktop-runtime-moved-28d05fa7059d`建立新副本升级至19、校验资产与可读任务后，通过原有`.desktop-data-path.json`选择新E盘副本。原db/settings操作前后SHA相同、凭据保留不外传；实际选择启动六项通过（926ms，旧任务可见，文章/检查点与模型账本不变）。本机选择与运行副本已忽略，不要删旧数据或盲目运行一次性迁移脚本。没有新包/推送/云计费；仍需多账号新用户导入、ready导出/系统选择器、长会话/整机RAM、checksum/故障恢复及冻结安装升级等完整验收。长期目标active。

## 2026-10-20 交互验收补齐（GLM 四批16项）

夹具 tests/seed_interaction_lists_native.py：两账号/4会话/可保存候选/三态任务/离线Mock；entry 记录全部 ice:request 并支持 fault-control.json 故障注入——写计数断言的依据。四原生专项（desktop/tests/）：interaction-lists(39)、dialog-matrix(38)、async-receipts(21)、strict-mode(4)，全部真实 CDP 键盘/真实 IPC 数据断言；6 项边界如实登记（运行中任务键盘激活、编辑器 flush UI 旅程、图片查看器/图片采纳等，需后续夹具）。产品修复：四处同 tick 连点 ref 双闸（requests.jsonl 实证 3 次同毫秒 chat.update）。Node233/类型/构建/分块全绿；ice_agent 零改动沿用 715。**移交 Codex：主进程 invoke 偶发不返回**（jobs.stop/续跑/browser-show；证据 key-activation-probe.cjs、resume-activation-probe.cjs；疑与 SQLite 锁/后台任务相关，未定性）。Python 全量未重跑（后端未改）。详见 docs/迭代任务/GLM-交互验收补齐执行记录-2026-10-20.md。

## 2026-10-21 后续工程与验收（GLM 三批十二项）

verify-workspace 新增 `-PrepareNativeFixtures`/`-PythonExe`：显式为注册表 prepare 标记的受控 mock 专项逐项播种新夹具（seed 附加 `-NativeName`，无用户输入拼接），每项证据钉死到 `<OutputDir>/native-evidence/<name>/{fixture,result}.json`；seed 失败仅阻断本项（blocked:seed-failed）。PS5.1 行为回归 7/7（默认不 seed、同家族独立 runtime、失败隔离、越界/构建失败依赖跳过）。统一入口实跑 4 专项串行 exit0/complete=true（39/41/22/39，四 runtime 互异，sourceChanged=false）；首轮 dialog-matrix 叠层 Esc 一次超时、单跑与干净重跑均通过，按长跑抖动记录未改产品。

新增 5 个原生/严格模式专项（Node 239→242）：strict-mode-palette(13，真开命令面板+转发观测真实计时器：挂载重放未触发即取消、用户开关恰+1、关闭归还焦点、快速开关仅当前面板、打开态卸载不聚焦已移除节点；含 ui.tsx Dialog 旧 opener 移除/禁用退让与关闭后跳转组件级复验)、dialog-focus(9，应用级关闭后跳转+reduced-motion 双态分别留档)、editor-debounce(9，三条旅程各自重播种，激活前计数+单调时差证明确在 800ms 窗口内，真实 RPC 读回 editor_draft)、editor-switch-block(16，草稿保存失败阻止切号/返回对话且全程无 articles.save，解除后同一动作完成)、image-lease(8，blob 租约用与产品一致的 <img> 探针前后对照——fetch 受 connect-src 限制不可作判据；切图位释放缩略图租约；延迟 4035ms 迟到响应按 id+elapsed 精确等待后不重建)。产品改动仅 CommandPalette 动作失败文案加「动作名」未执行前缀（C4）。嵌套原图关回缩略图沿用 interaction-integrity 既有断言未重复。glm-review(24)/dialog-matrix(41) 在 C4 入构建后复跑通过。Python 未重跑（715 为历史基线）。详见 docs/迭代任务/GLM-后续工程执行记录-2026-10-21.md；交回事项见其末节（首轮抖动复现指引、actionError 文案变更需同步断言）。


## 冻结候选与安装范围安全（2026-10-22）

见[本轮报告](../迭代任务/Codex-冻结候选与安装范围验收-2026-10-22.md)。stop-agent按新旧安装目录精确筛选，父子创建时间和停止前身份核对；默认release统一隔离候选构建，稳定spec／自有缓存／禁止发布／ASAR与ZIP/NSIS真载荷审计／实际冻结桌面。Node261、范围13、冻结20及离线文章完整流程通过。正式产品身份安装升级、真云、长期RSS、物理DPI、签名仍待；不能使用旧build/test-installer --integration的固定身份旧包冒充本轮安装验收。不得自动运行正式安装器覆盖个人数据。


## 安全卸载与独立NSIS（2026-10-22）

见[报告](../迭代任务/Codex-安全卸载与真实安装升级-2026-10-22.md)。编译SHA清单嵌入卸载器，按未改字节删除，不递归目录；相对/根/ADS/重复/junction等预检先于删除。NSIS实际新装/运行中同版本覆盖/重启/运行中卸载23项通过，文章图片/工作区/修改文件保留、另一ICE存活，卸载后DB读回会话1、模型调用0。Node267、删除6组、两候选冻结20过。ZIP-only钩子未初始化NSIS等待已修复并实际构建。

下一轮优先：原始旧卸载器仍递归，Stage仅识别工作区；散落在旧安装根的文件仍可能在覆盖时丢失。需要保护旧安装所有未知文件并做真正旧→新迁移，不能用本轮安全版同版本覆盖冒充；勿直接操作个人安装。随机测试注册与进程已归零。签名/真实云/物理DPI/长期RSS仍未完成。


## 2026-10-23 旧版迁移验收收尾

[完整报告](../迭代任务/Codex-旧版迁移与完整资料保护-2026-10-22.md)：旧安装整目录暂存、禁用旧递归卸载器、未知资料原位恢复、冲突保留、失败与新进程恢复；卸载仅删除编译清单中的未修改程序文件。修复NSIS原生System.dll与PowerShell托管引用冲突，以及构建配置合并导致旧dist混入的风险。

最终Node287/287（含专项26）、冻结桌面20、随机身份真实NSIS35通过；295输入在本次收尾仍与候选一致。卸载后会话1/模型调用0，最终测试注册/进程0。候选2cebc60b、安装证据de6ab39b，具体路径和SHA见报告。未签名、未覆盖个人安装、未提交推送。Python全量未在本批重跑。

后续优先事项：恢复点可视化与受控清理（需明确引用/所有权/保留策略）；真实历史库迁移复验；管理员/UAC与正式安装身份的隔离验收；签名及长时间浏览器/大图资源占用。真实模型、TapNow及微信仍须独立验证，整体上线目标保持开放。


## 2026-10-23 GLM体验复验与文章目录

见[报告](../迭代任务/Codex-GLM体验复验与文章目录-2026-10-23.md)。新增富文本/源码目录定位，正文和写请求保持不变；核实runtime本已隔离，移除两个列表专项的清键reload前置，保留精确选择器。最终quick+editor-outline八步完整通过，Node291/291、目录原生8；首轮其他原生96项通过，首轮统一因目录聚焦断言时序失败，证据未删。未改安装/迁移/预算，未打包。专注布局/diff导航/恢复点管理等继续待做。


## 2026-10-23 修改审阅与差异内存优化

[报告](../迭代任务/Codex-修改审阅与差异内存优化-2026-10-23.md)：修复提案列表缺base_document导致真实界面崩溃；逐提案/逐项导航与决定保留、同步防重、写成功读失败只读恢复、全部拒绝准确反馈；差异算法先剥公共字符串再分配。算法局部基准100万字符公共段峰值约161→50MiB，非整个应用RSS。Node293、Python编辑器9、原生11+8+9分轮通过，首轮两个失败与后续测试就绪条件修正见报告。提案列表数据分页、本页决定恢复和提交摘要、整进程长跑等待做。未打包。


## 2026-10-23 提案摘要分页

[报告](../迭代任务/Codex-提案摘要分页与按需详情-2026-10-23.md)：新proposals_page/get接口按账号文章限定；默认20摘要+单份选中详情，旧完整接口兼容。keyset支持同时间戳和已处理游标；跨页保留决定。最终统一10步完整，Node293、Python编辑器11、原生10+11过。25份夹具列表序列化14994437→4470B，详情另取，非总RAM。下一步决定离页恢复与提交摘要、整进程RSS；未打包。


## 2026-10-23 审阅决定持久化与提交确认

迁移20独立保存审阅选择与手改，账号/文章/基线及乐观版本检查，相同内容重试no-op；提交后事务性清理。前端串行自动保存、离页flush、失败保留/阻断、明确重新读取及提交摘要（未决定仍接受但明示，默认继续检查）。读失败不清空输入，已保存的旧决定按需释放。新UI提交带review_version，旧调用兼容。

最终Python758、Node298、统一12步complete=true、原生20+12+10共42通过，最终后端运行前后479输入一致，三个桌面夹具进程0。首轮Python的250ms时序断言失败后改为记录实际剩余timeout+真实socket关闭，连续3次及最终全量通过，未改产品超时逻辑。统一后仅改变这一测试，未改产品代码。解释器退出BufferedReader警告仍待定位；不得将进程0等同长期内存无泄漏。

证据根.test-tmp/codex-review-drafts-20261023，final-evidence.json/verified/report.json/python-final.log/process-audit.json；报告：[审阅可靠性报告](../迭代任务/Codex-审阅决定持久化与提交确认-2026-10-23.md)。旧构建回退需恢复升级前数据库备份；未改个人运行库、未打包提版推送。整体发行目标未完成；双草稿协调、远端已处理后的当前页提示、长期RSS和原发行边界继续待验收。


## 2026-10-23 正文与审阅并发保护

修复真实articles.proposal_decide误清正文工作草稿：save_body在正文写事务内检查未保存草稿，仅退役与旧正文完全相同的恢复副本，提交后新草稿保留；拒绝提案不改正文。UI应用与版本保存互斥，未保存正文/恢复稿有提示，全部拒绝可继续。远端已处理提案只读保留本地决定，可复制及明确移除，不能静默离页或重放提交。

完整Python762通过后Python产品代码未变；协议夹具stdout漏关已定位且修复，补丁后关键Python28及独立释放探针3通过，无该ResourceWarning。首轮统一因目录聚焦超时为17/18，保留失败。rAF暂停能确定性复现，改timer+当前文档/焦点/挂载守卫后，最终统一18/18、Node299、六组原生76、源码摘要59f6f4f906775f2f30dc668c9375adb7344d99c24c120da06436ebf32ee59731，运行中未变。24桌面夹具审计进程0。证据根.test-tmp/codex-editor-coordination-20261023，最终final-verified和final-evidence.json。

报告：[正文与审阅并发保护](../迭代任务/Codex-正文与审阅并发保护-2026-10-23.md)。未增加迁移、未提版打包推送，未改个人运行库。后续优先真实整进程内存长跑、正文版本刷新完成前的编辑协调、历史库/恢复点和原正式发行边界；不得将测试句柄修复等同于整体无泄漏或整体上线完成。


## 2026-10-23 大图与网页整进程内存

真实约18MB的3000×2000 PNG与离线HTTPS双画布，各20轮/10秒驻留+70秒自然空闲；20轮362.4秒、147检查通过。私有字节观测最高852.3MiB、自然空闲341.6MiB、单独GC338.9MiB；温机至后段中位数+34.2MiB，预设门128。最终图片租约/文件授权/远程网页0。9个受控目录审计残留进程0，不证明真实网站数小时无泄漏。

原图改为私有路径解析→主进程受控流→fetch Blob显示；路径解析不进renderer allowlist，二进制读完释放FD、关闭撤销Blob，保留图片。先直接img加载授权URL的方案被解码缓存复用回归否决，改Blob后关闭/迟到回复/跨账号/外部已知令牌隔离均通过。缩略图先缩放后旋转/转换，8向EXIF/透明度/原始字节测试通过。网页新增全站点释放确认，保留登录和已保存文件，关闭未完成下载/监听器，旧账号迟到操作不会释放新页面。

首轮统一15/15、Python768、Node311、四组原生210通过；同一基线PNG再补查12项，JS堆33.3→12.4MiB但整进程722→721MiB几乎相同，禁止宣称整体内存降低某百分比。发现新模块漏进发行清单，新增真实静态依赖闭包守护先红后绿；最终quick6/6、Node312、源码c1d2c554771670e2e4b53767e54191cb00ec6b3fa4a47a547e3dd2a0b186d1fa，运行中未变。期间244份运行文件不变，Python未在最后quick重跑。无迁移/依赖升级/提版/打包/推送，个人数据未动。

证据根.test-tmp/codex-memory-workflow-20261023：verified、final-verified、optimized-long-result.json、python-full.json/log、final-same-image-smoke.json、package-closure-red/green.log、process-audit.json、final-evidence.json。报告：[大图与网页整进程内存](../迭代任务/Codex-大图与网页整进程内存-2026-10-23.md)。使用说明：[图片与网页释放](../使用指南-图片与网页释放.md)。仍待正式冻结包、真实站点/模型长跑、历史库与恢复点、正式身份/UAC/签名等发行边界。


## 2026-10-23 工作区迁移准入与备份一致性

Store在主动改库前只读审计，包括最新版；未知/较新/缺记录/v18+漂移拒绝，旧记录不改写。run_migrations拒绝调用方未提交事务，不再误回滚人工编辑；初始化失败与旧基线备份连接显式关闭。备份预览使用同一FD前后hash，实际解压逐文件SHA，发布前再校验源包；目标暂存区完成数据库迁移后才发布。UI显示19→20及早期算法范围，500宽度实看通过。

实际历史提交6b5d63c的Store/TaskQueue生成schema11，副本升级20、内容/旧记录保留。由此发现旧数字hash导致同请求冲突；仅同域同负载已知格式转换，终态/结果/租约不变，异输入或新SHA漂移继续拒绝，并发仍复用原任务。可复用工具tools/verify-historical-store.py本地13检查通过，不是历史EXE或真实用户完整恢复。

实际选定工作区只读备份、副本19→20，2文章/6修订/19调用账本/0任务的计数与聚合SHA保留；原快照SHA未变，原工作区复核仍19。没有在其上运行DesktopService/Engine或执行原输出路径。源数据total_changes=0；报告不输出正文/Key。

首轮统一14/15：786Python、312Node通过，新native缺runtime被正确拒绝，未放宽验收器。补标识并修复真实旧任务后最终统一15/15、Python791唯一项/0跳过、Node312、四组原生82（28+26+16+12），源码dda1995df83b7128cb74d7a6eee47c00aea7743582c0785b4119a5d13966e76a前后不变。23新增后端回归、历史工具13、300连接采样中位3.4ms/P95 4.4ms；13受控目录审计残留0。

证据根.test-tmp/codex-migration-admission-20261023：verified失败、final-verified、python-final、historical-replay-red/green、personal-workspace-copy、open-cost、process-audit、final-evidence；未迁移个人原库、未提版/打包/推送。报告：[本轮报告](../迭代任务/Codex-工作区迁移准入与备份一致性-2026-10-23.md)。使用说明：[备份与迁移](../使用指南-工作区备份与迁移.md)。后续优先启动失败的工作区/备份图形入口、迁移前恢复点与安装升级恢复点管理、完整实际工作区/外部文件路径覆盖、正式冻结发行与真实服务/数小时使用验收；整体上线目标继续开放。


## Codex 2026-10-24 启动失败独立恢复

已验收GLM入门清单/会话上下文/大纲分析，修复统一editorial遗漏prepare导致复用已推进旧夹具的问题。新增startup-recovery.cjs + startup_recovery.py，损坏选择记录/数据库准入失败时可选择已有/新建/从备份恢复；无Service/任务消费，确认切换，保留原库，fresh成功启动后消耗。模块已入打包清单。

真实冻结验收发现ACP中文JSON编码错误，源码强制GBK回归先红后绿，改buffer输出UTF8。build/build-candidate --verify-desktop现在强制在常规桌面后再跑tools/verify-frozen-recovery.py；测试输入/播种依赖纳入源码摘要。旧候选2dccb843已标failed/recovery-failed，新候选a6e0579b为payload-desktop-and-recovery-verified。未安装/NSIS覆盖/提版/推送。

Python801（唯一801，0跳过）、Node320、统一16步/原生116，UTF8修复后另做801全量+固定夹具原生22+真实冻结桌面20/恢复10通过。统一16步在编码修复前，勿把它当修复后的同一轮；全部具体证据见docs/迭代任务/Codex-启动失败独立恢复-2026-10-24.md与.test-tmp/codex-startup-recovery-20261024。16受控目录初步进程审计0，最终目录见最新审计。

继续开放：自动预迁移恢复点/管理、基本profile目录写权限故障、跨Python迁移checksum兼容、实际安装发行/物理DPI/真实服务长跑。已有用户库不运行Engine或工作队列验收；仅受控副本。整体目标未完成。

收尾仅补backup播种wrapper的statSync重定向，并加底层拒绝未重定向个人文件stat的守护；重新seed后backup28/backup-migration26通过。此辅助脚本在801全量及新候选之后修改，应用生产源码相对候选变化0；不把旧全量冒充此后重新运行。固定证据stat-isolation-*，参见报告末节。


## Codex 2026-10-25 前端状态动效

用户要求开发同时继续打磨动效。本轮复用Motion14/Radix，无新依赖；公共Button加载改为绝对定位不定活动条，不再挤宽原按钮；TurnProgress终态优先且停止clock/typing，耗时不进入每秒状态播报；hidden停止计时与循环，visible按真实起点续计。备份进度/结果短透明度过渡，不移动可点击目标。

ActivityRail的实时偏好订阅清理支持OS偏好与根元素data-reduce-motion，保留父MotionConfig always语义。固定Motion useReducedMotion实现仅保存初值，已通过实际媒体双向变化与手动标记验证，未照搬文档而忽略当前依赖行为。

终轮deep17/17/source一致/Node324通过；实际组件动效28+backup28+dialog42+async22+editor-debounce9=129原生项。12次反复挂载warm/settled进度timer/可见性监听/文档动画0。先hidden窗口动画判据失败→改显示窗口，偏好切换真缺口→补实时订阅；类型标注遗漏导致首轮16/17→修正再跑17/17，全部保留证据。

报告docs/迭代任务/Codex-前端状态动效与反馈-2026-10-25.md；证据.test-tmp/codex-motion-feedback-20261025/final-green。独立node desktop/tests/motion-feedback-native.cjs自建受控fixture，需与其他原生串行；系统媒体模拟/合成可见性与事件，不是真模型/物理DPI/长期RSS。Python801仍为前轮基线，本轮未改后端且不重跑。HEAD4513985、未打包安装/提版/提交推送，恢复点/正式发行目标继续。


## Codex 2026-10-25 升级前完整恢复点

升级前完整恢复点与管理已实现。DesktopService在Store迁移及workers之前执行prepare_upgrade；原始数据库保持只读，完整包校验后才迁移，取消/磁盘不足先保留原库。新启动窗口用既有Motion ActivityRail，真实阶段/数量，无伪百分比；进入写库阶段禁取消。后台初始化普通工作区不误报“已保存恢复点”。原生will-navigate须兼容event.url，独立启动页正常RPC仍禁止。

recovery-points根有runtime绑定所有权，点有包/索引/记录hash；新增或同大小同mtime改文件也不能误复用。delete只在明确系统确认后移除内容未变的已知点，未知/未完成内容保留，不递归扫删，不自动retention。私有大容量策略不向renderer/外部ZIP开放。独立启动恢复菜单增加原工作区恢复点选择，原库失败也可用。

终轮deep22/22/source一致，Python819唯一项、Node327、业务原生162+动效28；历史源码13+完整点4通过。实际冻结新候选ZIP-only：桌面20+恢复15，包含EXE自动保存/中文协议/离线还原/0付费/暂停任务，生产源码变化0。候选.test-tmp/candidates/2026-10-25-028a2504-20ae-4b50-b5f6-068dad2656f0，未安装/提版/提交推送。证据与失败保留于.test-tmp/codex-upgrade-recovery-20261025，报告docs/迭代任务/Codex-升级恢复点与启动交互-2026-10-25.md。

首次统一入口拒绝嵌套fixture，整体非零，修正fixture目录而未放宽guard；早期导航参数缺陷和透明帧截图判据均修复后复验。下一轮不要重做此批；继续真实网站/长期整机内存/物理DPI/正式身份安装与签名验收，不能用本轮离线结果声称整体上线完成。容量上限实现不等于满32GB实测，当前实际大文件48MB。


## 2026-10-25 Codex复制/阅读收尾

见[本轮报告](../迭代任务/Codex-复制阅读复验与收尾-2026-10-25.md)。关闭复制文本往返/卸载回执缺口；主进程内存剪贴板验收替换无效页面注入；历史候选和配图旅程实际24项。最终Node352、五专项105检查、统一入口8步，详报告运行时序和首次失败。新GLM任务为[候选对照阅读与操作体验36项](../迭代任务/GLM-候选对照阅读与操作体验任务书-2026-10-25.md)。旧34/2是原GLM历史申报，保留供审计；本轮独立通过不回填旧记录来隐藏延期。核心后端/安装/真实服务目标仍按既有边界继续。
