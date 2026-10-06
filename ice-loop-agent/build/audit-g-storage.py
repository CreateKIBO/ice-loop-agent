"""Read-only G: inventory; writes only its report inside the project."""
import datetime
import ctypes
import heapq
import json
import os
from pathlib import Path
import shutil

ROOT = Path('G:/')
OUT = Path(__file__).resolve().parents[1] / 'docs' / 'G盘存储分析-2026-10-05.json'
errors = []
skipped = []
directories = []
largest = []
counts = {'files': 0, 'directories': 0, 'zero_byte_files': 0, 'errors': 0}
cluster_values = [ctypes.c_ulong() for _ in range(4)]
if not ctypes.windll.kernel32.GetDiskFreeSpaceW(str(ROOT), *(ctypes.byref(value) for value in cluster_values)):
    raise ctypes.WinError()
CLUSTER = cluster_values[0].value * cluster_values[1].value
SPECIAL = {'node_modules', '.venv', '.mimosa', '.uv-cache', '.git', 'build', '.gradle', '.intellijPlatform', '.test-tmp', 'release', 'dist', '.electron-cache', '.electron-builder-cache'}


def error(path, exc):
    counts['errors'] += 1
    if len(errors) < 100:
        errors.append({'path': str(path), 'error': str(exc)})


def walk(path, depth):
    total = 0
    files = 0
    allocated = 0
    dir_count = 1
    counts['directories'] += 1
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    stat = entry.stat(follow_symlinks=False)
                    if entry.is_symlink() or getattr(stat, 'st_file_attributes', 0) & 0x400:
                        skipped.append(entry.path)
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        child_total, child_files, child_allocated, child_dirs = walk(entry.path, depth + 1)
                        total += child_total
                        files += child_files
                        allocated += child_allocated
                        dir_count += child_dirs
                    else:
                        size = stat.st_size
                        total += size
                        files += 1
                        allocated += ((size + CLUSTER - 1) // CLUSTER) * CLUSTER
                        counts['files'] += 1
                        if size == 0:
                            counts['zero_byte_files'] += 1
                        item = (size, entry.path)
                        if len(largest) < 100:
                            heapq.heappush(largest, item)
                        elif item > largest[0]:
                            heapq.heapreplace(largest, item)
                except OSError as exc:
                    error(entry.path, exc)
    except OSError as exc:
        error(path, exc)
    # Keep shallow hotspots and all application subtree totals.
    if depth <= 3 or 'ice-loop-agent' in str(path) or Path(path).name in SPECIAL:
        directories.append({'path': str(path), 'depth': depth, 'bytes': total, 'files': files, 'estimated_file_allocation': allocated, 'directory_count': dir_count, 'estimated_allocation_lower_bound': allocated + dir_count * CLUSTER})
    if depth == 1:
        print(json.dumps({'finished': str(path), 'GiB': round(total / 2**30, 3), 'estimated_allocation_GiB': round((allocated + dir_count * CLUSTER) / 2**30, 3), 'files': files}, ensure_ascii=False), flush=True)
    return total, files, allocated, dir_count


before = shutil.disk_usage(ROOT)
started = datetime.datetime.now().astimezone().isoformat()
total, files, allocated, dir_count = walk(ROOT, 0)
after = shutil.disk_usage(ROOT)
report = {
    'started_at': started,
    'finished_at': datetime.datetime.now().astimezone().isoformat(),
    'read_only_scan': True,
    'root': str(ROOT),
    'disk_before': dict(zip(('total', 'used', 'free'), before)),
    'disk_after': dict(zip(('total', 'used', 'free'), after)),
    'logical_file_bytes': total,
    'allocation_unit_bytes': CLUSTER,
    'estimated_file_allocation_bytes': allocated,
    'estimated_directory_allocation_lower_bound': dir_count * CLUSTER,
    'estimated_allocation_lower_bound': allocated + dir_count * CLUSTER,
    'counts': counts,
    'directories': sorted(directories, key=lambda item: item['bytes'], reverse=True),
    'largest_files': [{'bytes': size, 'path': path} for size, path in sorted(largest, reverse=True)],
    'errors': errors,
    'skipped_links_or_reparse_points': skipped,
    'notes': 'Directory totals overlap. Estimated allocation rounds each file to the filesystem allocation unit and adds one unit per directory (minimum); larger directory tables, metadata and unreadable paths are not included. Actual space reclaimed can differ.',
}
OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'report': str(OUT), 'logical_GiB': round(total / 2**30, 3), 'counts': counts}, ensure_ascii=False), flush=True)
