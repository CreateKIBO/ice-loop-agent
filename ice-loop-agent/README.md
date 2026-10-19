# ICE Loop Studio 开发与使用说明

Windows 桌面公众号创作工作台，当前源码版本 **2.0.0-beta.2**。主界面使用 React、TypeScript、Radix UI、TanStack Query/Virtual、Motion 与 CodeMirror；Electron 提供内嵌浏览器和本地桥接，Python 引擎负责文章、模型、审核、资源、执行与导出。

本项目支持用户导入自己的公众号。ICE Loop 是随附示例档案，文章风格、配色与栏目应跟随当前账号配置。

## 1. 环境与源码启动

要求 Windows、Python 3.12+、兼容当前锁文件和 Vite 的 Node.js、npm。建议使用当前受支持的 Node LTS，并遵循依赖的 engines 要求；旧安装脚本里的 Node 22.12 最低提示不构成整条新版前端工具链的兼容保证。

以下命令在 `wechat_agent/ice-loop-agent` 目录运行，项目放在非 C 盘。已有 `.venv` 和 `node_modules` 时不必重复安装。项目运行和测试临时目录放在项目内，安装工具本身的缓存位置也应按本机要求配置。

```powershell
# 先进入你实际克隆的项目目录
Set-Location E:\Ice-agent\gonzhonhao\wechat_agent\ice-loop-agent
$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUTF8 = '1'
$env:TEMP = Join-Path (Get-Location) '.test-tmp\manual-dev'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:npm_config_cache = Join-Path (Get-Location) 'desktop\.npm-cache'
$env:ELECTRON_CACHE = Join-Path (Get-Location) 'desktop\.electron-cache'

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[server,test]'
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop/ui ci
npm.cmd --prefix desktop run build:components
npm.cmd --prefix desktop run build:ui
npm.cmd --prefix desktop run start:new-ui
```

上述为分步命令，请确认每步退出码为 0 再继续。若希望 Python、pip 或下载工具缓存也完全位于数据盘，先设置相应工具的缓存变量。已有安装脚本 `install-desktop.ps1` 主要用于旧启动入口；新界面还需要安装 `desktop/ui` 的依赖并构建 UI。不要只运行它就假定新界面已准备好。

`start-desktop.cmd` 是已有源码桌面入口。新工作台开发推荐明确运行 `start:new-ui`，不要直接用浏览器打开 UI HTML，它依赖 Electron 预加载桥接。Java 示例需要自行准备 JDK；Docker 隔离执行需要 Docker 及对应镜像。

## 2. 首次使用与模型配置

1. 在开始指南或公众号设置中创建/导入公众号，核对读者、栏目、品牌配色、写作规范和文章目录。
2. 导入历史文章并核对期号、栏目和发布状态。下一期按当前栏目已发布期号计算；存稿不能自动当作已发布。
3. 在模型设置中保存供应商、端点、模型 ID 与 Key，再配置实际写作主模型/备用模型及其他角色。只保存 Key 不代表已进入写作链。
4. 查看全局默认预算和当前任务预算。报 `MODEL_BUDGET_EXCEEDED` 时，按当前预算设置调整；不要反复点击生成。0 的具体含义以该项界面说明和后端校验为准，不能统一理解成不限额。
5. 按需设置模型输出上限并刷新目录元数据。目录未返回窗口信息时显示未知，不能猜测；当前字符保护也不等同精确 Token 计数。

供应商预置不保证某个模型 ID 永久可用。端点、名称、权限和能力应以用户实际服务为准。文本与视觉能力分别配置，不能因供应商品牌名称而假定所有模型均支持图片。

Key 通过桌面凭据流程处理，不应填入示例配置或提交到 Git；凭据不可用时按界面提示重新配置。备份不应被理解成能够跨机器无条件恢复系统凭据。

## 3. 推荐的文章制作流程

1. **选题依据**：选择栏目和目标期号，读取此前最近五个不同期号的正文及本栏全部历史标题；也可导入 MD/TXT/DOCX 大纲并预览、修改后选择期题。
2. **创作对话**：讨论观点或选择生成初稿。初稿是候选内容，确认后保存草稿，再按需要提交文章审核。保存、采纳、审批和发布是不同动作。
3. **修改与审阅**：编辑正文、查看差异、核对事实和代码证据。离开页面前处理未保存修改。审核应基于当前正文和证据，旧审核不能无条件复用。
4. **配图**：检查图位，复用已审核资源，或从真实执行记录截图；需要生成图片时查看和复制品牌提示词与参考图说明。
5. **网页操作**：在内嵌浏览器打开 [TapNow 中国站](https://app.tapnow.media/home)，由用户登录、上传参考图、粘贴提示词、生图并下载；返回资源箱导入、审阅、选用。
6. **导出与发布**：在可导出条件满足后选择目录，获得文本和图片内容，再在内嵌微信公众号后台由用户排版、上传图片、手机预览并发布。草稿导出允许的未完成项与就绪导出门控不同。
7. **记录进度**：真实发布后更新发布记录；需要换机器或恢复时使用备份流程，先预览，再恢复到新目录，未完成任务显式确认接续。

当前导出以 Markdown/纯文本及图片资源为核心，不会自动发布到微信。图片应来自当前账号、对应图位且通过选用审核；未完成占位符须在检查结果中明确呈现。

## 4. 数据、取消与清理

- 开发默认运行数据在 `.desktop-runtime/`；本机可能由 `.desktop-data-path.json` 或 `ICE_DESKTOP_RUNTIME` 选择其他工作区。此类内容均不入库。不要删除选择记录来“修复”真实用户数据。
- 内嵌浏览器按账号/站点保留会话；网页尺寸和面板收起操作不应重建登录环境。
- 取消会向实际模型网络请求发送停止信号；已被远端处理的内容仍可能产生费用。系统 DNS/证书准备不能声称已被强杀。
- 任务文件、代码证据与正式图片要区分保存用途；清理只能针对具有明确所有权的临时运行目录。不要按扩展名全盘删除，也不要按 Python/Electron 进程名批量结束程序。
- 测试使用自己创建的 `.test-tmp/` 子目录，不得拿个人工作区做夹具。目录清理前验证绝对路径、所有权标记、无 reparse/junction 及无活跃引用。

## 5. 检查命令

```powershell
# 在 ice-loop-agent 目录，先按上文设置非 C 盘 TEMP/TMP
npm.cmd --prefix desktop run check
npm.cmd --prefix desktop run check:tools
npm.cmd --prefix desktop run check:ui
npm.cmd --prefix desktop test
npm.cmd --prefix desktop run build:ui

# 隔离的完整 Python 离线基线（本地回环允许，阻止外网连接）
.\.venv\Scripts\python.exe -X utf8 -B docs/上线准备/run_full_checks.py

# 一个有针对性的后端专项
.\.venv\Scripts\python.exe -X utf8 -B -m unittest tests.test_network_control
```

按实际退出码判断结果，保留失败记录；不能让日志筛选管道吞掉失败。完整测试会生成自己的隔离目录和本地 JSON/日志，它们不入库；测试结束不代表其所有证据都可随意删除。`desktop/tests/*-native.cjs` 一般需要先运行对应 `tests/seed_*_native.py`，创建新的隔离夹具；阅读脚本入口后运行，不能复用他人机器或历史报告中的绝对路径。

截至 2026-10-19 最近已完成的基线：Python 713 项、Node 197 项；当前后端 197 个文件 SHA 与该次测试一致。源码 Electron 首次创作 30 项通过，含一次明确离线 Mock；Windows 冻结网络探针验证网络功能，不是完整软件新装/覆盖升级验收。

## 6. 研发入口与待验收范围

- [GLM 交互与工程整理任务单](docs/迭代任务/GLM-交互与工程整理-2026-10-19.md)
- [交接记录](docs/v2.0/HANDOFF.md)
- [验收矩阵](docs/上线准备/验收矩阵.md)
- [最新网络批次报告](docs/上线准备/流式取消与网络内存-2026-10-18.md)
- [模型窗口与输出控制](docs/上线准备/模型窗口与输出控制-2026-10-18.md)
- [选题排期与会话交接](docs/上线准备/选题排期与会话交接-2026-10-18.md)
- [大纲导入示例](docs/栏目选题大纲-示例.md)

源码报告中的 JSON、截图和大体积测试样本可能只保存在开发机，不随代码提交；可复用测试脚本仍在仓库，验收需重新生成自己的证据。

尚待进一步完成：精确模型输入 Token 与窗口预留、更大资料覆盖、真实供应商质量与复杂网络、浏览器/大图长时间整进程内存、历史迁移 checksum 过渡，以及完整冻结桌面与 NSIS 新装/覆盖升级。构建入口在 `build/build-release.ps1`，本轮不生成安装包，不提高版本号，不以旧包冒充当前源码。
