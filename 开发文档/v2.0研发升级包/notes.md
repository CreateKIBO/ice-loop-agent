# 资料核对记录

日期：2026-10-07。本次是报告编制，未重新运行 v1.5.3 测试、未升级用户安装版。现有测试结果来自已存档验收记录。

## 已核对的项目事实

- desktop/package.json 与 pyproject.toml 均为 1.5.3。Electron 44.5.1、electron-builder 26.0.12、esbuild 0.25.12、Shoelace 2.20.1、Motion 14.0.0；Python >=3.12，主要必选依赖 Pillow。
- renderer 当前是 JavaScript 模块/全局状态与模板式 DOM；creative-chat.js 使用轮询，候选编辑使用 textarea。并非 React/TypeScript 项目。
- creative_chat.py 已有真实流式回调、threading.Event 停止标记、结构化候选、澄清、引用、分支、保存、审批及内容哈希冲突保护。停止接口明确提示远端请求可能仍收费。因此不是“完全没有停止或流式功能”。
- desktop_service.py 的 JSON Lines 入口逐行调用 service.call；后台创作另用线程。不能把整个系统描述为全部同步阻塞，也不能假定所有重操作均已异步化。
- Store user_version 当前 9，已有 WAL、transaction、调用预留、任务租约、检查点、账本及操作幂等。升级须沿用并改善，不另造一套平行真相。
- main.cjs 已校验 IPC sender、方法白名单和载荷；browser.cjs 已用 WebContentsView，远程网页禁 Node、隔离上下文、启用 sandbox、按公众号/站点 partition。升级应保护这些边界。
- automation.cjs PreparationQueue 已有 busy 和内存 attempted 集合；自动截图使用全部运行记录，注释明确不推测图注对应输出。升级机会是持久化队列和图位到运行记录的精确关联。
- navigation-ux.js 当前为当前公众号本地记录搜索，不能等同于全文/段落级知识检索。
- v1.5.2 进度文档明确制作任务预算是次数，创作讨论独立请求尚不计入制作任务预算。应新增统一调用归属与会话预算；不可声称已有人民币费用总预算。
- publication_history.py 当前期号允许 1–9999；下一期基于已发布记录及人工发布进度。用户“不止十篇”的需求已不是十篇上限问题，下一轮应验证更多栏目及批量排期能力。
- 源码文件体积快照：desktop_service.py 97,290 字节、creative_chat.py 65,985、renderer/app.js 64,087、renderer/creative-chat.js 55,304。这是模块复杂度信号，不能单凭体积判定存在功能 bug。
- v1.5.3 验收记录：81 个不同后端测试、62 项 Node 检查；打包程序原生 49/85/32 项。它们是历史基线，未来 GLM 必须根据当前源码重跑适用集合。

## 官方资料与选型要点

- Tiptap https://github.com/ueberdosis/tiptap ：核心 MIT、基于 ProseMirror；Pro 扩展需要订阅。采用核心、自建版本/审批能力，不能误把所有扩展当免费。
- TanStack Query https://github.com/TanStack/query ：MIT，管理异步数据/缓存/更新，可包装 IPC Promise，并非必须 REST。
- TanStack Virtual https://github.com/TanStack/virtual ：长列表虚拟化，拟用于会话与资源。
- Radix https://github.com/radix-ui/primitives ：MIT，基础交互和无障碍组件。只用于新增 React 页面，旧页面保持 Shoelace 过渡。
- Motion https://motion.dev/docs/react-accessibility ：参考减弱动效。已有 Motion 本地依赖应复用。
- React Flow https://github.com/xyflow/xyflow ：MIT，拟用于任务图可视化；不默认引入任意脚本执行。
- Pydantic https://docs.pydantic.dev/latest/concepts/json_schema/ ：可导出 JSON Schema；Ajv https://github.com/ajv-validator/ajv 支持验证。生成产物必须检测漂移，运行时离线使用。
- remark https://github.com/remarkjs/remark ：Markdown AST 处理，减少正则破坏代码块/占位符。
- DOMPurify https://github.com/cure53/DOMPurify ：Apache-2.0 或 MPL-2.0 双许可，不是 MIT。
- SQLite FTS5 https://www.sqlite.org/fts5.html ：trigram 查询少于 3 字符不匹配，中文短词必须另有策略与测试；运行时须实测模块可用。
- Playwright Electron https://playwright.dev/docs/api/class-electron ：官方标为 experimental，保留现有原生 smoke 作最终打包验证。
- MarkItDown https://github.com/microsoft/markitdown ：MIT，多格式转 Markdown；其可选插件/联网能力应受控，不能默认上传文档。
- Cherry Studio https://github.com/cherryHQ/cherry-studio ：AGPL-3.0，只参考产品交互；不默认复制实现。
- Dify https://github.com/langgenius/dify/blob/main/LICENSE ：自定义许可附加条件，包含多租户限制；只参考工作流概念，不作为桌面程序底座。
- browser-use https://github.com/browser-use/browser-use ：作为浏览器 Agent 边界参考；本项目已有内嵌浏览器且以手工生图发布为默认，本轮不接管账户自动付费操作。

## 假设与待实施时验证

技术方案、性能指标、工作量为研发建议，不是现有测量结果。第三方库具体版本及所选扩展许可需编码开始时再次核验并锁定。本报告不评价 GLM 5.3 Flash 的真实上下文、工具或时长能力；用户执行端必须具备文件修改、终端和测试能力，纯聊天接口无法直接完成项目升级。

## 外部方案追加核对

用户提到Grok另有方案。发现并全文读取上级 `v2.0-GLM53-研发提升执行说明书.md`（34,089字节），作者归属尚待确认。对照记录见04；未修改原件。

- `ice_agent/__init__.py`确认PROTOCOL_VERSION=1；新协议必须兼容旧响应。
- `prompts/__init__.py`已有PROMPTS和PROMPTS_VERSION、nodes使用ctx.render；外部方案搬移nodes散落模板的描述不准确。
- `rules/markdown_ast.py`已有AST；前端remark与它须共同fixture验证。
- `image_tools.py:cover`/`resources.cover`已有覆底文本区域合成；新封面功能应增强复用。
- publication_history.context目标期号检查允许10000但文案写9999，是待复现边界线索；没有本次运行确认。
- 采用IR生成规范化、prompt快照、CodeMirror源模式最小适配/textarea回退、离线eval、模板叠字增强、移动预览和真心跳。
- 不采用动态公众号硬编码四线、最近一期替代前五正文、裸复制活动.db、未叠字底图标就绪、禁止最终打包或无证据启发式判stdout真伪。
- 官方SQLite backup资料：https://www.sqlite.org/backup.html 。CodeMirror旧GitHub仓库标官方托管迁移，不代表库停止维护；新托管与官网读取返回403，未假称读取成功。许可参考 https://github.com/codemirror/view/blob/main/LICENSE ，具体包需实施时再次确认。

文档合并时数次apply_patch上下文/顺序验证失败，未落入部分补丁；已读回确认状态、重新分文件应用并校验任务表。没有源码或用户数据变更。
