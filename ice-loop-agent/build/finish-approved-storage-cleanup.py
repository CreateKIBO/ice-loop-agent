"""Finish user-authorized A/B/C cleanup with a single Python filesystem pass."""
import datetime
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if ROOT != Path('G:/05-兴趣项目/gonzhonhao/wechat_agent/ice-loop-agent'):
    raise ValueError('Unexpected workspace')
TEST = (ROOT / '.test-tmp').resolve()
RELEASE = (ROOT / 'release').resolve()
VALIDATION = Path('G:/ICE-Installer-Validation')
DOCS = ROOT / 'docs'
archive = DOCS / 'G盘清理-2026-10-05-历史测试截图.zip'
with zipfile.ZipFile(archive) as z:
    evidence_count = len(z.infolist())
if evidence_count != 1602:
    raise ValueError('Historical evidence archive incomplete')
before = shutil.disk_usage('G:/')
kept, removed, failures = [], [], []


def remove_directory(path, parent):
    resolved = path.resolve(strict=True)
    if resolved.parent != parent or resolved != path.absolute() or path.is_symlink():
        raise ValueError('Deletion boundary mismatch: ' + str(path))
    try:
        shutil.rmtree(resolved)
        removed.append(str(resolved))
    except OSError as exc:
        failures.append({'path': str(resolved), 'error': str(exc)})


old_names = re.compile(r'^ICE-Loop-Studio-(1\.0\.0|1\.1\.0|1\.1\.1|1\.2\.0|1\.3\.0|1\.4\.0|1\.4\.1|1\.5\.0)-(Setup\.exe|x64\.zip)$')
old_files = [p for p in RELEASE.iterdir() if p.is_file() and old_names.fullmatch(p.name)]
if len(old_files) != 16:
    raise ValueError('Historical release set differs from approved report')
for path in old_files:
    if path.resolve().parent != RELEASE or path.is_symlink():
        raise ValueError('Release boundary mismatch')
    try:
        path.unlink()
    except OSError as exc:
        failures.append({'path': str(path), 'error': str(exc)})
print(json.dumps({'stage': 'old releases removed', 'free_GiB': round(shutil.disk_usage('G:/').free / 2**30, 2)}), flush=True)
if VALIDATION.exists():
    remove_directory(VALIDATION, Path('G:/').resolve())
print(json.dumps({'stage': 'old installer validation removed', 'free_GiB': round(shutil.disk_usage('G:/').free / 2**30, 2)}), flush=True)
for index, path in enumerate(list(TEST.iterdir())):
    if not path.is_dir():
        continue
    if path.name.startswith('budget-') or any(int(n) >= 1791180000000 for n in re.findall(r'\d{13}', path.name)):
        kept.append(str(path))
        continue
    remove_directory(path, TEST)
    if index % 100 == 0:
        print(json.dumps({'removed_this_pass': len(removed), 'failed': len(failures), 'free_GiB': round(shutil.disk_usage('G:/').free / 2**30, 2)}), flush=True)
after = shutil.disk_usage('G:/')
result = {'approved': ['A','B','C'], 'completed_at': datetime.datetime.now().astimezone().isoformat(),
          'method': 'Historical evidence archived before cleanup; slower PowerShell pass stopped and remaining targets enumerated, validated and removed in Python',
          'before_free_bytes_this_pass': before.free, 'after_free_bytes': after.free,
          'freed_bytes_this_pass': after.free - before.free,
          'historical_directories_removed_this_pass': len(removed), 'historical_directories_kept': len(kept),
          'historical_release_files_removed': sum(not p.exists() for p in old_files),
          'validation_removed': not VALIDATION.exists(), 'archived_evidence_count': evidence_count,
          'archive': str(archive), 'kept': kept, 'removed_this_pass': removed, 'failures': failures}
(DOCS / 'G盘清理-2026-10-05-结果.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k not in {'kept','removed_this_pass'}},ensure_ascii=False), flush=True)
if failures:
    raise SystemExit(1)
