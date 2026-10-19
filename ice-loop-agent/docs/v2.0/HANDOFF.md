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
