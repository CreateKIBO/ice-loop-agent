# v3 工作台优先：文档索引（2026-11-08）

v3 的方向与范围见 [开发报告](../上线准备/工作台优先转向-开发报告-2026-11-05.md)、[产品架构评审](../上线准备/工作台优先转向-产品架构评审与实施建议-2026-11-05.md)、[可插拔技能系统方案](../上线准备/可插拔技能系统-产品与迁移方案-2026-11-05.md)。逐项验收步骤在[本地验收清单](本地验收清单.md)，关键取舍记在 [DECISIONS](DECISIONS.md)。

## 迭代记录

| 版本 | 内容 | 验收清单 |
|---|---|---|
| P0 / P1 / P2 | [实施记录-P0](实施记录-P0.md) · [P1](实施记录-P1.md) · [P2](实施记录-P2.md) · [联调验收与修复](联调验收与修复-2026-11-05.md) | §1–§9 |
| v3.1 / v3.3 | [助手提问框](v3.1-助手提问框.md) · [提问框修复](v3.3-提问框修复.md) | — |
| v3.2 | [编辑器对齐公众号](v3.2-编辑器对齐公众号.md) | — |
| v3.4 | [文章内助手：局部修改提案与参考稿](v3.4-文章内助手.md) | §10 |
| v3.5 | [模型快速设置](v3.5-模型快速设置.md) | §10 |
| v3.6 | [起草方式与两版对照](v3.6-起草方式与两版对照.md) | §10 |
| v3.7 | [图片裁切压缩与 Word 导入](v3.7-图片与DOCX导入.md) | §11 |
| v3.8 | [左栏卡片、排版主题与组件](v3.8-左栏卡片、主题与组件.md) | §12 |
| v3.9 | [批量整理、发布日历、建议管理、素材标签](v3.9-运营：批量整理、日历、建议与素材.md) | §13 |
| v3.10 | [长图切片与 SVG](v3.10-长图切片与SVG.md) | §14 |
| v3.11 | [讨论后写初稿；异步边界](v3.11-讨论后写初稿与异步边界.md) | — |
| v3.12 | [微信兼容测试稿与性能样本](v3.12-兼容测试与性能样本.md) | §15–§16 |
| v3.13 | [作者试用记录](v3.13-作者试用记录.md) | §17 |
| v3.14 | [文章删除与回收站](v3.14-文章删除与回收站.md) | §18 |
| v3.15 | [技能导入导出与版本历史](v3.15-技能导入导出与版本历史.md) | §19 |
| v3.16 | [技能组合与作用域](v3.16-技能组合与作用域.md) | §20 |
| v3.17 | [会话技能](v3.17-会话技能.md) | §21 |
| v3.18 | [整体优化](v3.18-整体优化.md) | §22 |
| v3.19 | [技能参考资料与示例](v3.19-技能参考资料与示例.md) | §23 |
| v3.20 | [技能冲突检查](v3.20-技能冲突检查.md) | §24 |
| v3.21 | [导出边界与实测汇总](v3.21-导出边界与实测汇总.md) · [实测记录表](实测记录-2026-11.md) | §25 |
| v3.22 | [同步到公众号草稿箱](v3.22-同步到公众号草稿箱.md) | §26 |
| v3.23 | [留言设置与封面裁切](v3.23-留言设置与封面裁切.md) | §27 |
| v3.24 | [多图文草稿](v3.24-多图文草稿.md) | §28 |
| v3.25 | [编辑器里的多图文状态与发布授权草案](v3.25-多图文状态与发布授权草案.md) | §29 |
| v3.26 | [编辑器优化与封面裁切保存修复](v3.26-编辑器优化.md) · **[后续迭代规划](后续迭代规划-2026-11-08.md)** | §30 |
| v3.27 | [整体检查与优化](v3.27-整体检查与优化.md) | §31 |

> 验收清单章节号以清单本身为准；早期版本合并在 §10 之前的章节里。

## 代码地图（v3 新增部分）

| 领域 | 引擎（Python） | 界面（desktop/ui/src） |
|---|---|---|
| 文章存储、版本、导入、交付 | `ice_agent/documents/`（`store.py`、`service.py`、`schema.py`、`render.py`、`html_import.py`、`ops.py`） | `features/documents/`（`ArticleHome`、`DocumentEditor`（编辑与自动保存）、`EditorToolbar`、`ArticleSettings`、`PasteReportBar`、`DocumentSidePanel`、`docExtensions`） |
| 文章内 AI 助手 | `documents/assist.py`；路由在 `application/documents.py` | `DocumentAssistPanel.tsx` |
| 整篇起草 | `application/documents.py`（`_ai_draft`/`_ai_guided`）→ `creative_chat.py` | `ArticleHome.tsx` 的 AI 起草对话框 |
| 写作技能 | `skills.py`（设置、版本、组合与作用域、参考文件）、`skill_packages.py`（导入导出）、`skill_conflicts.py`（冲突检查） | `features/skills/`（`SkillSettings`、`SkillPackageTools`、`SkillScope`） |
| 兼容、性能、试用 | `documents/compat.py`、`perfsample.py`、`trial.py`；`tools/perf-v3-documents.py`、`tools/field-report.py`（实测汇总） | `CompatRecordPanel`、`PerfReadout`、`features/trial/` |
| 公众号草稿箱同步 | `ice_agent/wechat/`（`client.py` 接口、`sync.py` 单篇与多图文流程）；路由 `application/wechat.py` | `WeChatDraftPanel.tsx`、`WeChatGroupDialog.tsx`、`CoverCrop.tsx` |
| 数据库迁移 | `migrations/v3_schema.py`（v18 起） | — |
| 渲染层可调用的方法 | `application/documents.py` 的 `PUBLIC`、`workbench.py` 的 `METHODS` | `desktop/workbench-methods.cjs`（白名单） |

## 自动测试

```
python -m unittest tests.test_v3_documents tests.test_v3_ops tests.test_v3_assist tests.test_v3_generation \
  tests.test_v3_longimage tests.test_v3_compat tests.test_v3_perf tests.test_v3_trial tests.test_v3_delete \
  tests.test_v3_skill_packages tests.test_v3_skill_scope tests.test_v3_conversation_skills tests.test_v3_list_cache \
  tests.test_v3_skill_files tests.test_v3_skill_conflicts tests.test_v3_field_report tests.test_v3_wechat_drafts tests.test_writing_skills
node desktop/tests/documents-browser.cjs
node desktop/tests/skills-settings-browser.cjs
node desktop/tests/skills-packages-browser.cjs
node desktop/tests/skills-scope-browser.cjs
node desktop/tests/wechat-browser.cjs
node desktop/tests/layout-browser.cjs
node --test desktop/tests/ui-a11y.test.cjs
```
