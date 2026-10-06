# v2.0 依赖清单（DEPENDENCIES）

新增依赖在 M0-06 最小实验后锁定精确版本并补登记。现有依赖如下（2026-10-07 源码核对）。

## Python（pyproject.toml）

| 包 | 版本约束 | 许可 | 用途 | 打包状态 |
|---|---|---|---|---|
| Pillow | >=10,<13 | MIT-CMU | 图像解码/封面合成 | 已随 v1.5.3 冻结 |
| fastapi（extra） | >=0.115,<1 | MIT | server 模式（可选） | 未入冻结 |
| uvicorn（extra） | >=0.30,<1 | BSD-3 | server 模式（可选） | 未入冻结 |
| httpx（extra） | >=0.27,<1 | BSD-3 | 测试 | 未入冻结 |

计划新增（M0-06 验证后锁定）：pydantic（契约 schema 导出，MIT）。

## Node（desktop/package.json devDependencies）

| 包 | 锁定版本 | 许可 | 用途 |
|---|---|---|---|
| electron | 44.5.1 | MIT | 桌面运行时 |
| electron-builder | 26.0.12 | MIT | 打包 |
| esbuild | 0.25.12 | MIT | 构建 |
| @shoelace-style/shoelace | 2.20.1 | MIT | 旧页组件（过渡期保留） |
| motion | 14.0.0 | MIT | 动效（新页复用） |
| lucide | 0.468.0 | ISC | 图标 |

计划新增（M0-06 实验后锁定，2026-10-07，均锁精确版本）：

| 包 | 锁定版本 | 许可 | 用途 |
|---|---|---|---|
| react / react-dom | 19.3.0 | MIT | 新 renderer |
| vite | 8.3.3 | MIT | 构建（仅开发期，正式产物离线） |
| @vitejs/plugin-react | 6.1.2 | MIT | Vite React 插件 |
| typescript | 5.9.3 | Apache-2.0 | 类型检查（7.0.2 刚发布未采用，单独评估） |
| @tiptap/core、@tiptap/react、@tiptap/starter-kit、@tiptap/pm | 3.31.4 | MIT | 编辑器核心（无 Pro 扩展） |
| @tanstack/react-query | 5.104.1 | MIT | IPC 异步数据层 |
| @tanstack/react-virtual | 3.14.13 | MIT | 长列表虚拟化 |
| @radix-ui/react-dialog | 1.2.0 | MIT | 基础交互控件 |
| @radix-ui/react-dropdown-menu | 2.1.25 | MIT | 基础交互控件 |
| @radix-ui/react-select | 2.3.8 | MIT | 基础交互控件 |
| @radix-ui/react-switch | 1.3.8 | MIT | 基础交互控件 |
| @radix-ui/react-tabs | 1.1.22 | MIT | 基础交互控件 |
| @radix-ui/react-tooltip | 1.3.0 | MIT | 基础交互控件 |
| codemirror | 6.0.2 | MIT | Markdown 源模式（按需引入子包） |
| dompurify | 3.4.16 | Apache-2.0（双许可取 Apache，ADR-009） | 预览/粘贴清洗 |
| @xyflow/react | 12.12.0 | MIT | 工作流图投影 |
| ajv | 8.20.0 | MIT | 构建期 standalone 校验器代码生成 |
| zustand | 5.0.15 | MIT | 面板/选择状态 |

Python 计划新增：pydantic 2.13.5（MIT，契约权威 schema；venv 已存在，M1-01 写入 pyproject 锁定 >=2.13,<3）。

规则：所有新增包锁精确版本；许可逐包核验记录；正式包不依赖 CDN/dev server；Ajv 用构建时 standalone 产物。
