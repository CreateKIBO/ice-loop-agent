"""A UTF-8 Markdown and reviewed-image bundle for manual publication."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from pathlib import Path

from ..paths import assert_within, atomic_write_text, ensure_dir


def rewrite_images(body: str, references: dict[str, str]) -> str:
    lines = []
    fence = None
    for line in body.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$', line)
        if marker:
            run, tail = marker.groups()
            if fence is None:
                fence = (run[0], len(run))
            elif run[0] == fence[0] and len(run) >= fence[1] and not tail.strip():
                fence = None
            lines.append(line)
            continue
        if fence is None:
            for original, replacement in references.items():
                pattern = r'^(\s*!\[[^\]\r\n]*\]\()' + re.escape(original) + r'(\)\s*)$'
                line = re.sub(pattern, lambda m: m[1] + replacement + m[2], line)
        lines.append(line)
    return ''.join(lines)


def _files(folder: Path) -> dict[str, str]:
    result = {}
    for path in folder.rglob('*'):
        assert_within(path, folder)
        if path.is_symlink():
            raise ValueError('发布包包含链接，请另存或移走原包后重新导出')
        if path.is_file():
            result[path.relative_to(folder).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def check_target(target: Path, manifest: Path) -> None:
    from .exporter import ExportConflict
    if not target.exists():
        return
    if target.is_symlink() or not target.is_dir() or not manifest.is_file():
        raise ExportConflict('发布包已存在但无法核对来源，请移走或重命名原包后重新导出')
    old = json.loads(manifest.read_text(encoding='utf-8'))
    if old.get('folder_name') != target.name or _files(target) != old.get('files') or {p.name for p in target.iterdir()} != {'文本', '图片'}:
        raise ExportConflict('发布包在上次导出后被修改，请保留修改并移走原包后重新导出')


def destination(ctx, article_root: Path, folder_name: str) -> tuple[Path, Path]:
    root = article_root / '发布包'
    assert_within(root, article_root)
    target = root / folder_name
    assert_within(target, root)
    # Metadata lives in the evidence archive, outside the two-folder publication bundle.
    # Relative naming also remains valid after backup restore to another workspace.
    return target, article_root / folder_name / '.ice-publication-manifest.json'


def export_publication(ctx, archive: Path, target: Path, manifest: Path,
                       body: str, figures: dict[int, str], title: str,
                       series: str, episode: int, readiness: str) -> dict:
    check_target(target, manifest)
    parent = ensure_dir(target.parent)
    staging = Path(tempfile.mkdtemp(prefix='.publishing-', dir=parent))
    previous = None
    try:
        text_dir = ensure_dir(staging / '文本')
        image_dir = ensure_dir(staging / '图片')
        references = {}
        for no, reference in figures.items():
            source = archive / reference
            assert_within(source, archive / 'images')
            name = source.name
            shutil.copyfile(source, image_dir / name)
            references[reference] = '../图片/' + name
        body = rewrite_images(body, references)
        atomic_write_text(text_dir / '01-公众号正文.md', body)
        status = '可进入人工发布预览' if readiness == 'ready_for_publish' else '草稿 / 待审核或补图，不能据此认定已就绪'
        information = '\n'.join([
            '标题：' + title, f'栏目与期号：{series} / {episode:03d}',
            '状态：' + status, '摘要：' + str(ctx.state.get('abstract') or '待填写'), '',
            '手动发布：打开微信公众号后台，新建图文，粘贴/排版正文，再从图片文件夹上传对应配图。',
            '微信后台不会直接把 Markdown 文件渲染成图文；可先用自己的 Markdown 排版工具处理，再粘贴。',
            '插图顺序以正文图号为准。预览手机效果并完成事实核验后，由你确认发布。',
            f'已选用图片：{len(figures)} 张。未完成的图位仍保留待配图说明。', '',
        ])
        atomic_write_text(text_dir / '02-发布信息.txt', information)
        hashes = _files(staging)
        # Recheck immediately before replacement; do not overwrite manual edits.
        check_target(target, manifest)
        if target.exists():
            previous = Path(tempfile.mkdtemp(prefix='.previous-publishing-', dir=parent))
            previous.rmdir()
            target.rename(previous)
        try:
            staging.rename(target)
            atomic_write_text(manifest, json.dumps({'folder_name': target.name, 'files': hashes}, ensure_ascii=False, indent=2))
        except Exception:
            if target.exists():
                assert_within(target, parent)
                shutil.rmtree(target)
            if previous and previous.exists():
                previous.rename(target)
            raise
        if previous:
            assert_within(previous, parent)
            shutil.rmtree(previous)
        return {'publishing_folder': str(target), 'publishing_files': sorted(hashes),
                'publishing_layout': ['文本', '图片']}
    finally:
        if staging.exists():
            assert_within(staging, parent)
            shutil.rmtree(staging)
