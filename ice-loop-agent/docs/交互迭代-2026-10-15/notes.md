# 调研与发现

当前：main 6fcca5a，源码 beta.2，工作区干净，G 盘约 6.1 GiB 可用。HANDOFF 记录现有新工作台、预算、交付审阅、进度流和素材归档入口；本轮先核查可用体验，不直接假定报告完整。

## 调研（官方来源，2026-10-15）

- assistant-ui Thread：https://www.assistant-ui.com/elements/thread 。借鉴阅读时保留滚动位置、显式回到最新、完成消息动作。未引入其 runtime，保留本项目 IPC/预算/审阅模型。
- assistant-ui threads：https://www.assistant-ui.com/docs/runtimes/concepts/threads 。会话列表应明确加载/失败和列表语义；本项目现已返回全账户列表，本轮不再把旧的50/10截断当当前缺陷。
- Linear Search：https://linear.app/docs/search 。借鉴稳定搜索入口和清晰范围，本轮会话/草稿用同一检索词，并显示匹配与清空入口。
- Radix Dialog：https://www.radix-ui.com/primitives/docs/components/dialog 。沿用已有焦点约束、Esc关闭与受控表单；用于重命名和草稿预览。
- Radix Dropdown：https://www.radix-ui.com/primitives/docs/components/dropdown-menu 。调研备选，本轮无需新增菜单层级。
- 本地 ui-ux-pro-max 给出 minimal-modern/清晰边界/可扫描/避免低对比与装饰渐变；最终沿用 ICE Loop 信号蓝、暖白、现有中文字体，不采用通用落地页的 hero 建议。

## 发现与实施

- AI 消息原样 pre-wrap，Markdown标题/表格/代码不易读：复用现有 unified + remark-parse + remark-gfm，React显式标签渲染，代码复制；原始HTML作为文字，不执行、不自动载入远程图片；链接按钮明确为复制地址。
- 缺少会话标题位置和重命名入口：添加紧凑头部、120字符表单、成功后列表与详情同步刷新，不改文章标题。
- 历史阅读时原逻辑不抢滚动，但没有回到最新/未读入口：添加显式按钮、真实新回复计数，并处理按需排版和容器尺寸变化。
- 输入只有 sessionStorage 且模式不保留：增加账户+会话隔离的localStorage恢复，30天/60项限额，仅清理自己的记录；失败可见，迟到成功回执不清除新输入；中文IME/keyCode229不发送。
- 停止动作原catch吞错：成功给等待说明、失败可见且可重试。
- 草稿弹窗显示原始Markdown：增加排版/源码切换、代码/正文复制、加载失败重试；搜索同时覆盖草稿标题/栏目。

## 验证进度

Node123/123、类型检查通过。首次直接引入阅读器使启动包623KB，改按需共享解析器后498.17KB，构建无500KB警告。所有测试在G盘，未付费调用/打包/发布。

首次原生：排版安全/代码复制/重命名落库/跨会话隔离/模式恢复通过；Page.reload 后等待条件读到了尚未销毁的旧DOM，随即点击时新页面尚未就绪。保留失败记录，改为新文档标记+readyState，再用全新fixture重跑。并补发送等待期快速轮询及显式预算错误码识别。

最终：123/123 Node、TS/Vite通过；修复缓存会话已读初始化顺序后，用新fixture完成17/17原生检查，JS异常0。已查看实际对话/草稿截图。无云模型调用、覆盖安装或推送。入口498.32KB（gzip156.02KB），解析模块按需加载。源码、调研、证据和后续边界已记入迭代报告。
