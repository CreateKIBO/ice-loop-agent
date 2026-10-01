# ICE Loop Agent 开发研究记录

调研日期：2026-10-01（Asia/Shanghai）。

## 项目输入
- 用户要求：自动撰写文章、浏览器访问 TapNow 生图、程序截图；考察可改造开源程序；详细开发文档。
- 既有项目：Windows，G:\05-兴趣项目\gonzhonhao，ICE Loop 四栏目与文章文件夹契约。
- 事实来源优先官方网页/文档和项目仓库；尚未实测登录后的 TapNow。

## 待核验
- TapNow 的正式地址、浏览器编辑器与公开 API 能力。
- browser-use、LangGraph、Playwright、OpenHands、Dify、Skyvern 的适配性与许可。
- 本地截图与执行隔离、任务恢复、人工批准机制。

## 已确认与发现
- 用户确认：app.tapnow.media；独立桌面程序。
- TapNow 官方已公开 MCP 接入，media 地址：https://mcp.tapnow.media/api/agent-gateway/mcp/general/mcp。
- 来源：https://docs.tapnow.ai/en/docs/mcp/add-a-custom-connector 与 https://docs.tapnow.ai/en/docs/mcp/use-tapnow-in-other-agents。
- 尚未授权、探测工具 schema、生成或下载；公共文档描述不能代替用户账户验收。
- browser-use、LangGraph 为 MIT；Dify 为附加条件的许可；其他候选按 LICENSE 进一步核验。
- 旧文章模板含私有仓库链接和时长承诺，应以 AGENTS.md 和品牌手册的较新明确规则覆盖。

## 技术结论
- 推荐 Electron/React 桌面壳 + Python sidecar + LangGraph + Playwright；browser-use 作为受限降级模块，不放开无限生图动作。
- 浏览器模式为用户明确功能，必须真实单图验收；MCP 是可选结构化路径，不能取消浏览器需求。
- 网页截图、真实运行日志视图、原生 Windows 窗口分别建模与标注，不用生图生成运行截图。
- 外部生成使用本地唯一操作账本、发送租约、unknown 对账；不假设远端幂等，重启不盲目重发。
- 分开任务完成状态与文章就绪状态；批准按内容 hash 绑定，手改使关联证据失效。
- 同时保留隔离执行与已审阅本机模式；subprocess 与静态扫描不是沙箱。

## 关键官方来源
- https://github.com/browser-use/browser-use 与 LICENSE（MIT）
- https://github.com/browser-use/web-ui（MIT / Gradio 原型）
- https://github.com/langchain-ai/langgraph（MIT）
- https://docs.langchain.com/oss/python/langgraph/interrupts （恢复节点开头重跑）
- https://github.com/microsoft/playwright（Apache-2.0）
- https://playwright.dev/python/docs/auth、/downloads、/screenshots
- https://github.com/Skyvern-AI/skyvern（AGPL-3.0）
- https://github.com/langgenius/dify/blob/main/LICENSE（附加条件）
- https://github.com/OpenHands/OpenHands（读取到当前 README 为 Agent Canvas，顶层 MIT）
- https://github.com/n8n-io/n8n/blob/master/LICENSE.md（Sustainable Use License 等）
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/api/safe-storage
- https://pywinauto.readthedocs.io/en/latest/getting_started.html

## 交付
- output/开发文档/ICE-Loop-Agent-开发设计文档.md：26 节、含模块、数据表、接口、流程、测试、任务与工时。
- 没有安装依赖、没有登录/调用生成、没有截图用户桌面、没有修改已有文章与 AGENTS.md。
- 独立读者审查发现三个契约缺口，已修订并复查通过：M0最小提交账本、未知结果对账接口、多次输入采集顺序。
- 格式验证改用PowerShell完成，python命中不可启动WindowsApps别名；真实应用应探测实际解释器路径。
- 新增 output/开发文档/开发文档审查记录.md，记录验证范围与尚未实测能力。

## v1.1 国内模型调研
- 用户补充：文章生成必须接入 AI，主要使用中国的新模型。
- DeepSeek 官方入口列 deepseek-flash 与 deepseek-v4-pro，当前 Flash 对应 V4.1；不复制旧 deepseek-chat/reasoner 配置。https://api-docs.deepseek.com/ 与 /quick_start/pricing/。
- Qwen 官方模型目录列 qwen3.8-max、qwen3.7-plus、qwen3.8-flash；百炼同时提供其他厂商模型。https://help.aliyun.com/zh/model-studio/models。
- 百炼地域/业务空间 base_url 与 API Key 配套；Coding/Token Plan 文档限制后端服务用途，本项目采用普通模型 API。https://help.aliyun.com/zh/model-studio/base-url。
- Kimi 官方目录含 kimi-k3、kimi-k2.7-code、kimi-k2.6；CN API https://api.moonshot.cn/v1。https://platform.kimi.com/docs/get-api-key。
- GLM-5.3 官方说明仅文本、始终思考，不能统一发送 disabled，Chat与Responses端点不同。https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3。
- 方舟官方OpenAI兼容示例 model doubao-seed-2-1-pro-260628，base_url https://ark.cn-beijing.volces.com/api/v3。https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh。
- Qwen结构化输出按模型/模式区分：https://help.aliyun.com/zh/model-studio/qwen-structured-output。
- DeepSeek Responses schema与Chat JSON模式区分；JSON可能空内容，思考工具循环保留协议会话字段。https://api-docs.deepseek.com/api/create-response/、/guides/json_mode/、/guides/thinking_mode/。
- Kimi response_format文档描述模型间schema差异：https://platform.kimi.com/docs/guide/response_format。
- 新模型目录为2026-10-01官方文档快照，非账号可调用验收；不同服务平台的模型ID不能互换。
- v1.1写入第9.5–9.16节并同步功能、架构、数据模型、接口、测试与backlog；写作必须有模型API，先Qwen/DeepSeek双国内路径。
- 独立读者复审要求补required_off；已加入硬约束，主/备用不能退化为prefer_off，增加MODEL_CAPABILITY_MISMATCH与合同测试。
- 没有执行任何模型请求；新增配置与最新模型ID只是已核验官方资料的设计快照。
