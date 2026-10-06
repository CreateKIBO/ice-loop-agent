# v2.0 基线审计（M0-01 / M0-02）

日期：2026-10-07。run_id: v2-run001。本文件记录当前源码事实，不引用历史验收作为本次通过。

## 版本与运行路径

| 项 | 值 |
|---|---|
| ice_agent `__version__` | 1.5.3 |
| PROTOCOL_VERSION | 1 |
| desktop/package.json | 1.5.3（ice-loop-studio） |
| Electron | 44.5.1 |
| electron-builder | 26.0.12 |
| esbuild | 0.25.12 |
| Shoelace | 2.20.1 |
| Motion | 14.0.0 |
| lucide | 0.468.0 |
| Python 要求 | >=3.12（venv 实际 3.12.13） |
| 必选依赖 | Pillow>=10,<13 |
| 可选 | fastapi/uvicorn（server extra）、httpx（test extra） |
| SQLite user_version | 9（2026-10-07 源码核对，待运行库再次核对） |
| Git | 仓库根 `G:/05-兴趣项目/gonzhonhao/wechat_agent`；main 分支 @deee775；v1.5.3 大量改动已暂存未提交 |

## 工作区边界地图

- 应用源码：`G:\05-兴趣项目\gonzhonhao\wechat_agent\ice-loop-agent`（本轮唯一写授权源码区）
- 开发文档：`G:\05-兴趣项目\gonzhonhao\wechat_agent\开发文档\`（只读参考）
- 升级包：`开发文档\v2.0研发升级包\`（00–04+notes，已全文阅读）
- 用户真实文章工作区：E 盘（**只读边界，本轮禁止自动迁移/覆盖**）
- 本轮日志/临时：`ice-loop-agent\.test-tmp\v2-run001\`
- 状态文件：`ice-loop-agent\docs\v2.0\`
- 发行目录：`ice-loop-agent\release\`、`dist\`（历史包保留不删）

## SQLite schema 摘要（user_version=9）

21 张表：articles, article_revisions, jobs, steps, artifacts, sources, claims,
asset_slots, asset_candidates, approvals, operations, model_invocations, events,
checkpoints, approval_choices, publication_resources, publication_drafts,
publication_history, publication_progress, publication_plans, asset_reviews,
editorial_topics, editorial_topic_imports。

关键机制（domain/store.py）：
- `schema_version>9` 拒绝打开（旧引擎防写新库）；`<9` 时先 backup 到 `<stem>-before-v1.0.db` 再执行 `_SCHEMA`（CREATE IF NOT EXISTS 幂等）。
- WAL 模式；`transaction()` 支持 BEGIN IMMEDIATE 嵌套共享外层事务。
- `reserve_invocation`/`finish_invocation`：按 job 计数的模型调用预算。
- `claim_job`/`release_job`：jobs.lease 单租约。
- 唯一约束：operations.operation_key UNIQUE；publication_history UNIQUE(account_id,source_key)；editorial_topics UNIQUE(account_id,series,episode)。

## RPC 方法清单（M0-02）

desktop_service.py `call()` 分派（`ice_agent/desktop_service.py:150-213`）：

直接 dispatch（~60 个）：
bootstrap, jobs.list/create/get/resume/stop, automation.capture_failure,
brief.suggest, history.list/get/update/progress, planning.context/propose/confirm,
outlines.list/read/preview/save/update/match, accounts.save/switch/import/export,
resources.list/import/preview/analyze/apply/use/update/vision/recommend,
vision.save/probe, drafts.list/get/save, approvals.decide/edit,
articles.save/finalize/revisions/compare/restore,
supplements.create/plan/from_library/prepare/execute, assets.review,
backup.create/inspect/restore, assets.import/select/preview/capture_context/capture_finish,
execution.approve/inputs/code_save/policy_save, claims.verify,
models.save/probe, secrets.set, library.list/read

模块 METHODS 集合：
- TaskLifecycle（task_lifecycle.py:37）: jobs.archive, jobs.delete, jobs.restore
- CreativeChat（creative_chat.py:83）: chat.list/create/get/update/send/stop …（详见 creative_chat.py METHODS）
- Workbench（workbench.py:17）: rules.list/save/resolve/remove, tools.status/diagnostics/execution_settings/provider_check …

未知项：无（全部分派入口已定位）。旧 ID（article_id/history_id/job_id/candidate_id/slot_id/topic_id）不重编号。

ID 映射：article → article_revisions(kind) → jobs(article_id) → asset_slots(article_id) → asset_candidates(slot_id) → approvals(job_id)；publication_history 按 (account_id, source_key) 独立。

## Electron IPC（desktop/main.cjs）

- 已校验 sender、方法白名单、载荷；browser.cjs 用 WebContentsView、remote 禁 Node、contextIsolation+sandbox、按公众号/站点 partition。
- preload.cjs 暴露受控 invoke 面（详见 preload.cjs）。

## 现有测试与打包入口

- Python：tests/ 30 个文件（test_store、test_runner、test_creative_chat、test_workflow、test_upgrade 等）
- Node：desktop/tests/*.test.cjs（62 项）
- smoke wrapper：desktop/tests/chat-smoke.cjs（ICE_PACKAGED_EXE）、prompt-smoke.cjs（ICE_TEST_EXECUTABLE）、browser-smoke.cjs（参数见脚本）
- 构建：build/build-release.ps1（全量冻结）、build/repack-ui.ps1（仅 UI）、verify-release.cjs、verify_release.py
- 打包白名单风险：electron-builder files 未含 `ui/`、`main-services/`（本轮新增时须显式加入）

## 大文件复杂度信号（notes.md 核对一致）

desktop_service.py 97,290 B；creative_chat.py 65,985 B；renderer/app.js 64,087 B；creative-chat.js 55,304 B

## 必须保护的 v1.5.3 不变量（本轮全程）

1. execution/process.py + runner.py：子进程独立 stdin PIPE、EOF 语义、JobObject 收束、2MiB 输出上限、独立 TEMP、-B、证据归档
2. staging 清理仅限本次 owner/marker
3. 教学预期错误 vs 意外失败区分；错误素材显式批准
4. 原图按需加载、缩放/拖动、关开防串图、关闭释放
5. 候选不覆盖人工改稿；发布快照只读；hash 冲突保护
6. endpoint/SSRF/密钥日志规则、required_off、fallback 过滤
7. browser WebContentsView 隔离边界
8. 安装器只停本安装的进程
