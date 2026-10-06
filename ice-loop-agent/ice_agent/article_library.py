"""Bounded recursive, read-only article library shared by history and chat."""
from __future__ import annotations

import re
from pathlib import Path

from .domain.types import sha256_text
from .paths import assert_within, normalize

BODY_NAMES = ('01-公众号正文-v2.md', '01-公众号正文.md', '正文.md')


def library_entries(account: dict) -> list[dict]:
    value = account.get('library_root', '')
    if not value or not Path(value).is_dir():
        return []
    root = normalize(value)
    columns = {c['code'] for c in account['columns']}
    result: list[dict] = []
    # Only article folders and one level of configured columns, never a drive scan.
    folders = []
    for item in sorted(root.iterdir()):
        if not item.is_dir():
            continue
        try:
            assert_within(item, root)
            if item.name in columns:
                folders.extend(p for p in sorted(item.iterdir()) if p.is_dir())
            else:
                folders.append(item)
        except (OSError, ValueError):
            continue
    for folder in folders:
        try:
            assert_within(folder, root)
            file = next((folder / name for name in BODY_NAMES if (folder / name).is_file()), None)
            if not file:
                continue
            assert_within(file, root)
            if file.stat().st_size > 400000:
                continue
            body = file.read_text(encoding='utf-8-sig')
            title = next((line[2:].strip() for line in body.splitlines() if line.startswith('# ')), folder.name.partition('-')[2] or folder.name)
            series = folder.parent.name if folder.parent.name in columns else ''
            issue = re.match(r'^(\d{1,4})-', folder.name)
            episode = int(issue[1]) if issue and series else None
            relative = folder.relative_to(root).as_posix()
            result.append({'folder': relative, 'title': title, 'has_body': True,
                           'series': series, 'episode': episode, 'file_path': str(file),
                           'body': body, 'source_hash': sha256_text(body)})
        except (OSError, UnicodeError, ValueError):
            continue
    return result


def read_library(account: dict, folder: str) -> dict:
    entry = next((r for r in library_entries(account) if r['folder'] == folder), None)
    if not entry:
        raise ValueError('存稿不存在或超出当前公众号目录')
    # Preserve the original raw-byte hash used by supplement source verification.
    import hashlib
    return {**entry, 'readonly': True, 'source_hash': hashlib.sha256(Path(entry['file_path']).read_bytes()).hexdigest()}
