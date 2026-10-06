# v2.0 验证记录（VALIDATION）

格式：命令 → 环境 → 结果（exit/统计）→ 日志路径。只记录本轮实际执行。

## V-001 Node 基线（M0-03）

- 命令：`cd desktop && E:/Node/node.exe --test tests/*.test.cjs`
- 环境：Node v24.14.1，Windows 11，G 盘项目目录
- 结果：exit 0；tests 62 / pass 62 / fail 0（与 v1.5.3 存档 62 项数量一致）
- 日期：2026-10-07
- 日志：.test-tmp/v2-run001/node-baseline.log

## V-002 Python 基线（M0-03）

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest discover -s tests -t . -v`
- 环境：Python 3.12.13（项目 venv），PYTHONUTF8=1
- 结果：第1、2、3次运行被执行环境问题中断（KI-008/KI-009：残留引擎阻塞、后台任务连带终止）；第4次独占运行结果见下（完成后回填）
- 日志：.test-tmp/v2-run001/python-baseline4.log

## V-005 v2.0 新增测试汇总（M0-04/05/08/09、M1-01…M1-10）

| 测试文件 | 项数 | 结果 |
|---|---|---|
| tests/test_v2_migrations.py | 6 | 全部通过（V-003） |
| tests/test_v2_contracts.py | 7 | 全部通过 |
| tests/test_v2_protocol.py | 7 | 全部通过 |
| tests/test_v2_events.py | 5 | 全部通过 |
| tests/test_v2_task_queue.py | 10 | 全部通过 |
| tests/test_v2_dispatch.py | 2 | 全部通过 |
| tests/test_v2_cancel_idempotency.py | 4 | 全部通过 |
| tests/test_v2_m1_exit.py | 5 | 全部通过（含真实子进程协议） |

- 日期：2026-10-07
- 说明：v2 新增 46 项与 v1.5.3 既有套件分离计数，最终统计去重后并入交付报告

## V-003 迁移框架与备份恢复（M0-04/05/08/09）

- 命令：`.venv/Scripts/python.exe -X utf8 -B -m unittest tests.test_v2_migrations -v`
- 结果：exit 0；6/6 通过（迁移幂等、dry-run 回滚、故障注入回滚、新库拒绝、备份运行中阻断+往返一致、恢复拒绝已存在目录/坏 hash）
- 日志：.test-tmp/v2-run001/v2-migrations-tests.log
- 日期：2026-10-07

## V-004 依赖最小实验（M0-06）

- 步骤：npm install（desktop/ui，163 包，exit 0）→ node scripts/gen-validators.mjs（Ajv standalone 代码生成）→ vite build（exit 0，616KB bundle）→ tsc --noEmit（通过）
- 离线/CSP 核验：dist 产物 grep `new Function(` 与 `eval(` 均为 false
- FTS5 探测：venv SQLite FTS5 与 trigram tokenizer 均可用（运行时再随引擎核验）
- pydantic：2.13.5 已在 venv（尚未写入 pyproject，M1-01 时正式加入）
- 说明：TypeScript 锁 5.9.3（7.0.2 刚发布未选用，降级风险；后续单独评估）；产物单 chunk>500KB 提示后续代码分割
- 日期：2026-10-07
