"""Create a readable report from the completed read-only inventory."""
import json
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / 'docs'
r = json.loads((DOCS / 'G盘存储分析-2026-10-05.json').read_text(encoding='utf-8'))
gib = lambda value: f'{value / 2**30:.2f}'
ds = sorted(r['directories'], key=lambda d: d['estimated_allocation_lower_bound'], reverse=True)
lookup = {str(Path(d['path'])): d for d in ds}
app = DOCS.parent


def size(path):
    return gib(lookup[str(Path(path))]['estimated_allocation_lower_bound'])


lines = [
    '# G 盘存储分析 · 2026-10-05',
    '',
    f"扫描时间：{r['finished_at']}。本轮只读取磁盘，写入本报告与清单；没有删除文件、修复磁盘或继续写入安装器。",
    '',
    f"磁盘容量 {gib(r['disk_after']['total'])} GiB，已用 {gib(r['disk_after']['used'])} GiB，剩余 {gib(r['disk_after']['free'])} GiB。",
    '',
    f"扫描到 {r['counts']['files']:,} 个文件、{r['counts']['directories']:,} 个目录。文件内容大小合计 {gib(r['logical_file_bytes'])} GiB。G 盘的分配单元为 128 KiB；小文件和目录的分配开销很大。按文件大小向上取整、每个目录至少一个分配单元估算，占用合计 {gib(r['estimated_allocation_lower_bound'])} GiB，与磁盘已用量接近。",
    '',
    '下列占用均为估算值，实际释放量可能略有差异。父子目录不可重复相加。不可读取目录不计入；本报告不会把它们视为零占用。',
    '',
    '## 顶层目录',
    '',
    '| 目录 | 文件内容 GiB | 估算磁盘占用 GiB | 文件数 |',
    '|---|---:|---:|---:|',
]
for d in ds:
    if d['depth'] == 1:
        lines.append(f"| `{d['path']}` | {gib(d['bytes'])} | {gib(d['estimated_allocation_lower_bound'])} | {d['files']:,} |")
lines += [
    '',
    '## 可供选择的清理项',
    '',
    '下列项目只是候选，必须等用户决定后再删除。',
    '',
    '| 编号 | 路径 / 范围 | 估算 GiB | 用途及清理影响 |',
    '|---|---|---:|---|',
    f"| A | `{app / '.test-tmp'}` | {size(app / '.test-tmp')} | 历史测试运行目录，含模拟数据库、测试素材及浏览器配置。可先保留验收截图、日志和当前版本证据，再清理历史部分；当前版本待验收数据暂留。 |",
    f"| B | `G:\\ICE-Installer-Validation` | {size('G:/ICE-Installer-Validation')} | 旧安装器验收副本、旧安装包及临时解压包。确认无在用进程或需保留数据后可清理。 |",
    f"| C | `{app / 'release'}` 中 1.0.0–1.5.0 的 16 个 Setup.exe / x64.zip | 2.70 | 历史发行包；删除后无法直接使用这些包回退。保留 1.5.1、1.5.2 及 win-unpacked。 |",
    f"| D | `G:\\04-AI实验\\Ai_helper\\node_modules` | {size('G:/04-AI实验/Ai_helper/node_modules')} | 第三方依赖；删除后项目需要重新安装依赖才能运行。应保留 package.json、锁文件和源码，确认没有手工修改依赖。 |",
    f"| E | `G:\\99-压缩包坟场` 内三个旧项目 node_modules | {gib(sum(lookup[str(Path(p))]['estimated_allocation_lower_bound'] for p in ['G:/99-压缩包坟场/graduation_design/LowcodeEngine/frontend/node_modules', 'G:/99-压缩包坟场/graduation_design/LowcodeEngine_test/frontend/node_modules', 'G:/99-压缩包坟场/graduation/node_modules']))} | 旧项目依赖，可重新安装；不是直接删除整个旧项目。精确路径见下方依赖清单。 |",
    f"| F | `G:\\1\\.mimosa` | {size('G:/1/.mimosa')} | 会话钩子状态、baseline 和失败记录；清理会丢失对应历史状态。是否有保留价值需要用户决定，不能当作普通 npm 缓存。 |",
    f"| G | `G:\\05-兴趣项目\\gonzhonhao\\.mimosa` | {size('G:/05-兴趣项目/gonzhonhao/.mimosa')} | 当前公众号项目的钩子历史状态，清理影响同上，优先保留当前活跃状态。 |",
    f"| H | `G:\\1\\.uv-cache` | {size('G:/1/.uv-cache')} | Python 下载与解包缓存，清理后后续安装可能需要重新下载。 |",
    f"| I | `{app / 'desktop' / '.electron-cache'}` | {size(app / 'desktop' / '.electron-cache')} | Electron 下载缓存，后续打包可能重新下载；先完成本次安装器更稳妥。 |",
    '| J | `G:\\03-比赛\\reicom\\datasets.zip` | 1.02 | 同目录存在解压后的 datasets。确认解压内容完整、无需保存原始压缩包后，才考虑删除 ZIP。 |',
    '',
    '建议先评估 A、B、C：理论上合计约 11.17 GiB；A 保留验收证据和当前测试数据后实际释放量会稍少。保留当前构建必需的 desktop/node_modules、.venv、release/win-unpacked、当前发行包和 dist，避免中断本次安装器工作。',
    '',
    '## 主要依赖 / 状态目录',
    '',
    '| 完整路径 | 估算磁盘占用 GiB |',
    '|---|---:|',
]
special = {'node_modules', '.venv', '.mimosa', '.uv-cache', '.intellijPlatform', '.gradle'}
selected = []
for d in ds:
    p = Path(d['path'])
    if p.name in special and not any(Path(s['path']) in p.parents for s in selected):
        selected.append(d)
for d in selected[:25]:
    lines.append(f"| `{d['path']}` | {gib(d['estimated_allocation_lower_bound'])} |")
lines += ['', '## 最大文件（前 20 项）', '', '| 路径 | 内容 GiB |', '|---|---:|']
for item in r['largest_files'][:20]:
    lines.append(f"| `{item['path']}` | {gib(item['bytes'])} |")
lines += ['', '## 无法读取的内容', '']
for item in r['errors']:
    lines.append(f"- `{item['path']}`：{item['error']}")
lines += [
    '',
    '上述 .git 目录实际报 WinError 1392（损坏且无法读取），并非单纯没有权限。本轮没有修改它，也没有运行 chkdsk。应保留可读源码并单独确认仓库备份，再处理磁盘修复。FOUND.000 / FOUND.001 为恢复文件目录，当前体积很小，未列为清理优先项；回收站几乎为空。',
    '',
    '原始完整清单：`G盘存储分析-2026-10-05.json`。',
]
out = DOCS / 'G盘存储分析-2026-10-05.md'
out.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(out)
