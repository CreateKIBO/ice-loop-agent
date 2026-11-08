"""v3.21 实测汇总：从一份运行数据目录的**副本**里汇总可自动读取的实测记录，生成 Markdown 报告。

用法（Windows PowerShell，在 ice-loop-agent 目录）：
  python tools/field-report.py --runtime D:\\ICE数据\\runtime --out D:\\实测\\汇总.md
  python tools/field-report.py --runtime ... --perf D:\\实测\\perf-1.json --perf D:\\实测\\perf-2.json

读取内容（只读；先把 app.db 复制到临时目录再打开，原数据不被迁移或修改）：
- 环境：源码 HEAD / 分支、系统、Python、数据库版本
- 每个公众号：文章 / 回收站 / 版本 / 交付 / 发布登记数量；写作技能组合、版本与参考文件数
- “微信兼容测试稿”的逐项记录（粘贴后 / 后台保存后 / 手机预览）与统计
- 最近一次“作者试用记录”
- 性能基准结果（tools/perf-v3-documents.py 的 JSON，可多份）

不读取正文、密钥与模型调用内容；报告里只有数量、标题、技能名称和你在兼容记录里写的说明。
需要人工填写的项（真实微信截图、模型质量评分、Word 样本损失等）见 docs/v3.0/实测记录-2026-11.md。
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def git(*args: str) -> str:
    try:
        return subprocess.run(['git', '-C', str(ROOT), *args], capture_output=True, text=True, timeout=10).stdout.strip() or '未知'
    except (OSError, subprocess.SubprocessError):
        return '未知'


def accounts_of(runtime: Path) -> dict[str, str]:
    settings = runtime / 'settings.json'
    if not settings.exists():
        return {}
    data = json.loads(settings.read_text(encoding='utf-8'))
    return {aid: (value.get('brand') or {}).get('name') or value.get('name') or aid
            for aid, value in (data.get('accounts') or {}).items()}


def table_exists(conn, name: str) -> bool:
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def count(conn, sql: str, *args) -> int:
    try:
        return conn.execute(sql, args).fetchone()[0]
    except sqlite3.Error:
        return 0


def nest(line: str) -> str:
    """把子报告的标题降三级，嵌进本报告的“公众号”小节下。"""
    return '###' + line if line.startswith('#') else line


def account_section(store, account_id: str, name: str) -> list[str]:
    from ice_agent.documents.compat import CompatTesting
    from ice_agent.documents.service import DocumentService
    from ice_agent.documents.trial import TrialLog
    from ice_agent.skills import WritingSkills

    conn = store.conn
    out = [f'## 公众号：{name}（{account_id}）', '']
    if not table_exists(conn, 'documents'):
        return out + ['数据库里还没有文章表（未升级到 v3）。', '']
    rows = [
        ('文章（正常）', count(conn, "SELECT COUNT(*) FROM documents WHERE account_id=? AND lifecycle='active'", account_id)),
        ('回收站', count(conn, "SELECT COUNT(*) FROM documents WHERE account_id=? AND lifecycle='trashed'", account_id)),
        ('AI 初稿（全部）', count(conn, "SELECT COUNT(*) FROM documents WHERE account_id=? AND origin='ai'", account_id)),
        ('稳定版本', count(conn, 'SELECT COUNT(*) FROM document_versions WHERE account_id=?', account_id)),
        ('交付记录（复制 / 导出 / 草稿箱）', count(conn, 'SELECT COUNT(*) FROM document_deliveries WHERE account_id=?', account_id)),
        ('其中同步到草稿箱', count(conn, "SELECT COUNT(*) FROM document_deliveries WHERE account_id=? AND kind='wechat_draft'", account_id)),
        ('多图文草稿（组）', count(conn, 'SELECT COUNT(*) FROM wechat_draft_groups WHERE account_id=?', account_id)),
        ('草稿箱写入结果未知（待核对）', count(conn, "SELECT COUNT(*) FROM wechat_operations WHERE account_id=? AND state='unknown'", account_id)),
        ('发布登记（有效）', count(conn, "SELECT COUNT(*) FROM publication_records WHERE account_id=? AND state='active'", account_id)),
        ('AI 助手提案', count(conn, 'SELECT COUNT(*) FROM document_proposals WHERE account_id=?', account_id)),
    ]
    out += ['| 项 | 数量 |', '|---|---|'] + [f'| {k} | {v} |' for k, v in rows] + ['']
    account = {'id': account_id}
    try:
        state = WritingSkills(store, account).get()
        skills = {s['id']: s for s in state['skills']}
        main = skills.get(state.get('active_skill_id'))
        addons = [skills[a]['name'] for a in state.get('active_addon_ids', []) if a in skills]
        versions = count(conn, 'SELECT COUNT(*) FROM writing_skill_versions WHERE account_id=?', account_id) \
            if table_exists(conn, 'writing_skill_versions') else 0
        files = count(conn, 'SELECT COUNT(*) FROM writing_skill_files WHERE account_id=?', account_id) \
            if table_exists(conn, 'writing_skill_files') else 0
        out += ['**写作技能**：主技能 ' + (f'{main["name"]} v{main["version"]}' if main else '不使用') +
                (f'；辅助技能 {"、".join(addons)}' if addons else '') +
                f'；共 {len(skills)} 个技能，历史版本 {versions} 条，参考文件 {files} 个，系列设置 {len(state.get("series_bindings", {}))} 个。', '']
    except Exception as error:  # 旧库或损坏：如实写出
        out += [f'写作技能读取失败：{error}', '']
    docs = DocumentService(SimpleNamespace(runtime=Path(tempfile.gettempdir())), store, account)
    compat = CompatTesting(docs)
    samples = [r[0] for r in conn.execute(
        "SELECT document_id FROM documents WHERE account_id=? AND meta_json LIKE '%\"compat_sample\"%' ORDER BY created_at", (account_id,))]
    out += [f'### 微信兼容记录（{len(samples)} 篇测试稿）', '']
    if not samples:
        out += ['还没有“微信兼容测试稿”。在文章首页点“微信兼容测试稿”生成，再在侧栏“兼容记录”里逐项填写。', '']
    for document_id in samples:
        try:
            report = compat.report({'document_id': document_id})
            out += [nest(line) for line in report['markdown'].splitlines()] + ['']
        except Exception as error:
            out += [f'- {document_id}：读取失败（{error}）', '']
    out += ['### 作者试用记录', '']
    try:
        trial = TrialLog(store, account).report({})
        out += [nest(line) for line in trial['markdown'].splitlines()] + ['']
    except Exception as error:
        out += [f'没有可汇总的试用记录（{error}）。', '']
    return out


def perf_section(paths: list[str]) -> list[str]:
    if not paths:
        return ['## 性能基准', '', '没有提供 `--perf` 结果。运行 `python tools/perf-v3-documents.py --out 结果.json` 后用 `--perf 结果.json` 汇总。', '']
    out = ['## 性能基准', '']
    results = []
    for raw in paths:
        try:
            results.append((raw, json.loads(Path(raw).read_text(encoding='utf-8'))))
        except (OSError, ValueError) as error:
            out.append(f'- {raw}：读取失败（{error}）')
    names = []
    for _, data in results:
        for key in (data.get('timings') or data.get('samples') or {}):
            if key not in names:
                names.append(key)
    if results:
        head = '| 项（中位数 ms） | ' + ' | '.join(Path(p).name for p, _ in results) + ' |'
        out += [head, '|---|' + '---|' * len(results)]
        for key in names:
            cells = [str((data.get('timings') or data.get('samples') or {}).get(key, {}).get('median_ms', '—')) for _, data in results]
            out.append(f'| {key} | ' + ' | '.join(cells) + ' |')
        out.append('')
        for path, data in results:
            env = data.get('environment') or {}
            sample = data.get('sample') or {}
            out.append(f'- {Path(path).name}：HEAD {data.get("head", "?")}，{env.get("platform", "?")}，'
                       f'样本 {sample.get("chars", "?")} 字 / {sample.get("images", "?")} 图，峰值内存 {data.get("peak_rss_mb", "?")} MB')
        out.append('')
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description='v3 实测汇总（只读，基于数据副本）')
    parser.add_argument('--runtime', required=True, help='应用的运行数据目录（含 app.db 与 settings.json）')
    parser.add_argument('--account', action='append', help='只汇总指定公众号（可重复）；默认全部')
    parser.add_argument('--perf', action='append', default=[], help='perf-v3-documents.py 的结果 JSON（可重复）')
    parser.add_argument('--out', help='报告保存路径；不填则打印')
    args = parser.parse_args()

    runtime = Path(args.runtime).resolve()
    database = runtime / 'app.db'
    if not database.exists():
        print(f'没有找到 {database}', file=sys.stderr)
        return 2
    temp = Path(tempfile.mkdtemp(prefix='ice-field-report-'))
    try:
        copy = temp / 'app.db'
        source = sqlite3.connect(f'file:{database.as_posix()}?mode=ro', uri=True)
        try:  # 用 SQLite 备份接口复制，正在运行的应用写入一半的事务不会被带进来
            target = sqlite3.connect(copy)
            source.backup(target)
            target.close()
        finally:
            source.close()
        with sqlite3.connect(copy) as probe:
            schema = probe.execute('PRAGMA user_version').fetchone()[0]
        from ice_agent.domain.store import Store
        store = Store(copy)
        try:
            accounts = accounts_of(runtime) or {r[0]: r[0] for r in store.conn.execute('SELECT DISTINCT account_id FROM documents')}
            if args.account:
                accounts = {k: v for k, v in accounts.items() if k in args.account}
            lines = ['# v3 实测汇总', '',
                     f'- 生成时间：{time.strftime("%Y-%m-%d %H:%M:%S")}',
                     f'- 源码：{git("rev-parse", "--short", "HEAD")}（分支 {git("rev-parse", "--abbrev-ref", "HEAD")}）',
                     f'- 系统：{platform.platform()}；Python {platform.python_version()}',
                     f'- 数据目录：{runtime}；数据库版本 v{schema}（汇总基于副本，原库未改动）',
                     f'- 公众号：{len(accounts)} 个', '',
                     '> 本报告只包含程序能读到的记录。真实微信粘贴/保存/手机预览以兼容记录里你填写的结果为准；'
                     '“未验”不计为通过。模型质量、Word 样本损失等人工项见《实测记录》。', '']
            for account_id, name in accounts.items():
                lines += account_section(store, account_id, name)
        finally:
            store.close()
        lines += perf_section(args.perf)
        text = '\n'.join(lines).rstrip() + '\n'
        if args.out:
            Path(args.out).write_text(text, encoding='utf-8')
            print(f'已写入 {args.out}')
        else:
            print(text)
        return 0
    finally:
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
