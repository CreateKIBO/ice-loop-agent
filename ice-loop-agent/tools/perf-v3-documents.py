"""v3 文章引擎性能基准（开发报告 §9 性能固定样本、§10 第 3 项）。

在一个**新建的临时运行目录**里生成固定样本（默认约 1 万字 / 30 张测试图），测量引擎侧操作耗时与进程峰值内存，
输出 JSON。不读取、不修改任何个人工作区、公众号或模型配置；结束后删除临时目录（--keep 保留）。

    python tools/perf-v3-documents.py                      # 默认样本，打印 JSON
    python tools/perf-v3-documents.py --out perf.json      # 另存结果
    python tools/perf-v3-documents.py --workdir D:\\perf    # Windows：导出图文包必须在非 C 盘目录

只测引擎（Python）部分。编辑器首次可编辑、输入响应与渲染进程内存请打开应用里的“性能样本”文章，
在侧栏“性能读数”里查看（见 docs/v3.0/v3.12-兼容测试与性能样本.md）。
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def peak_rss_mb() -> float | None:
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(peak / (1024 * 1024 if sys.platform == 'darwin' else 1024), 1)
    except ImportError:
        pass
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t),
                        ('WorkingSetSize', ctypes.c_size_t), ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPagedPoolUsage', ctypes.c_size_t), ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaNonPagedPoolUsage', ctypes.c_size_t), ('PagefileUsage', ctypes.c_size_t),
                        ('PeakPagefileUsage', ctypes.c_size_t)]
        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return round(counters.PeakWorkingSetSize / (1024 * 1024), 1)
    return None


def timed(samples: dict, name: str, fn, repeat: int = 1):
    values, result = [], None
    for _ in range(repeat):
        start = time.perf_counter()
        result = fn()
        values.append((time.perf_counter() - start) * 1000)
    samples[name] = {'runs': repeat, 'median_ms': round(statistics.median(values), 1), 'max_ms': round(max(values), 1),
                     'all_ms': [round(v, 1) for v in values]}
    return result


def git_head() -> str:
    try:
        return subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True,
                              timeout=10).stdout.strip() or 'unknown'
    except (OSError, subprocess.SubprocessError):
        return 'unknown'


def main() -> int:
    parser = argparse.ArgumentParser(description='v3 文章引擎性能基准（临时目录、固定样本）')
    parser.add_argument('--chars', type=int, default=10_000)
    parser.add_argument('--images', type=int, default=30)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--repeat', type=int, default=5)
    parser.add_argument('--workdir', help='临时目录的父目录（Windows 上导出图文包需非 C 盘）')
    parser.add_argument('--out', help='结果 JSON 另存路径')
    parser.add_argument('--keep', action='store_true', help='保留临时运行目录便于检查')
    args = parser.parse_args()

    import PIL
    from ice_agent.documents import perfsample
    from ice_agent.documents.markdown_io import content_to_md
    from ice_agent.documents.service import DocumentService
    from ice_agent.domain.store import Store

    parent = Path(args.workdir).resolve() if args.workdir else None
    if parent:
        parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='ice-perf-', dir=str(parent) if parent else None))
    runtime = root / 'runtime'
    runtime.mkdir()
    store = Store(runtime / 'app.db')
    samples: dict = {}
    notes: list[str] = []
    try:
        docs = DocumentService(SimpleNamespace(runtime=runtime), store, {'id': 'acct-perf'})
        sample = timed(samples, 'build_sample', lambda: perfsample.build(docs, chars=args.chars, images=args.images, seed=args.seed))
        document_id = sample['document_id']
        detail = timed(samples, 'open_document', lambda: docs.get({'document_id': document_id}), args.repeat)
        content = detail['content']
        revision = detail['revision']

        def edit_and_save():
            nonlocal revision
            blocks = content['doc']['content']
            first = next(b for b in blocks if b['type'] == 'paragraph')
            first['content'][0]['text'] += '。'
            saved = docs.save_working({'document_id': document_id, 'base_revision': revision, 'content': content})
            revision = saved['revision']
            return saved
        timed(samples, 'save_small_edit', edit_and_save, args.repeat * 2)
        version = timed(samples, 'commit_version', lambda: docs.commit_version({'document_id': document_id, 'base_revision': revision}))
        version_id = version['version_id']
        timed(samples, 'render_preview', lambda: docs.render_delivery({'document_id': document_id, 'version_id': version_id}), args.repeat)
        payload = timed(samples, 'copy_payload_embed', lambda: docs.copy_payload({'document_id': document_id, 'version_id': version_id}), 3)
        samples['copy_payload_embed']['html_kb'] = round(len(payload['html']) / 1024)
        timed(samples, 'markdown_projection', lambda: content_to_md(content), args.repeat)
        timed(samples, 'long_image_page', lambda: docs.long_image_page({'document_id': document_id, 'version_id': version_id, 'width': 375}), 3)
        try:
            from ice_agent.paths import assert_not_c_drive
            target = root / 'export'
            assert_not_c_drive(target)
            timed(samples, 'export_bundle', lambda: docs.export_bundle({'document_id': document_id, 'version_id': version_id,
                                                                         'destination': str(target)}))
        except Exception as error:  # Windows C 盘等环境限制：如实记录，不算失败
            notes.append(f'export_bundle 未测：{error}（可用 --workdir 指定非 C 盘目录）')
        result = {
            'tool': 'perf-v3-documents', 'head': git_head(), 'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'environment': {'platform': platform.platform(), 'python': platform.python_version(), 'pillow': PIL.__version__,
                            'cpu_count': os.cpu_count(), 'machine': platform.machine()},
            'sample': {'chars': sample['chars'], 'images': sample['images'], 'seed': sample['seed'],
                       'image_mb': round(sample['image_bytes'] / 1024 / 1024, 2),
                       'registry': [{k: item[k] for k in ('index', 'width', 'height', 'format', 'bytes', 'sha256')}
                                    for item in sample['registry']]},
            'timings': samples, 'peak_rss_mb': peak_rss_mb(), 'notes': notes,
            'scope': '仅引擎（Python）侧；编辑器首次可编辑/输入响应/渲染进程内存需在应用内“性能读数”中测量。',
        }
    finally:
        store.close()
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding='utf-8')
    print(text)
    if args.keep:
        print(f'临时目录已保留：{root}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
