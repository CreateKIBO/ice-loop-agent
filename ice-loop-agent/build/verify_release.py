"""Check distributables contain current binaries and no actual workspace data."""
import hashlib,json,zipfile,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
release=root/'release';app=release/'win-unpacked'
version=json.loads((root/'desktop/package.json').read_text(encoding='utf-8'))['version']
def digest_file(path):
    with path.open('rb') as file:return hashlib.file_digest(file,'sha256').hexdigest()
selected=['ICE Loop Studio.exe','resources/app.asar','resources/engine/ice-engine.exe','resources/teaching-python/python.exe','resources/engine-project/BUILD.json']
with zipfile.ZipFile(release/f'ICE-Loop-Studio-{version}-x64.zip') as archive:
    names=archive.namelist()
    forbidden={'credentials.json','app.db','settings.json','Cookies','Local State'}
    bad=[name for name in names if Path(name).name in forbidden or '/.desktop-runtime/' in name or '/.test-tmp/' in name]
    if bad:raise ValueError('Workspace data unexpectedly included: '+str(bad))
    # PyInstaller 6 onedir 把纯模块字节码按 __pycache__/x.pyc.<magic> 落盘——这是
    # 托管格式，不是源码树漏收的缓存；只拦截"裸 .pyc / .pyo"（collect_data_files
    # 从源码 __pycache__ 带入的形态）。
    import re as _re
    stray_cache=[name for name in names
                 if _re.search(r'__pycache__/[^/]+\.py[co]$', name)]
    if stray_cache:raise ValueError('Generated Python cache unexpectedly included: '+str(stray_cache[:3]))
    for name in selected:
        matches=[entry for entry in names if entry==name or entry.endswith('/'+name)]
        if len(matches)!=1:raise ValueError('Missing/duplicate release entry: '+name)
        with archive.open(matches[0]) as stream:value=hashlib.file_digest(stream,'sha256').hexdigest()
        if value!=digest_file(app/name):raise ValueError('ZIP contains stale file: '+name)
for name in ['ice-engine.exe']:
    if digest_file(root/'dist/ice-engine'/name)!=digest_file(app/'resources/engine'/name):raise ValueError('Release contains an old engine')
setup=release/f'ICE-Loop-Studio-{version}-Setup.exe'
sevenzip=root/'desktop/node_modules/7zip-bin/win/x64/7za.exe'
for name in selected:
    # Stream exact installer entries without retaining another copy of the binaries.
    process=subprocess.Popen([str(sevenzip),'e',str(setup),name,'-so'],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    checksum=hashlib.sha256();size=0
    for chunk in iter(lambda:process.stdout.read(1024*1024),b''):
        checksum.update(chunk);size+=len(chunk)
    errors=process.stderr.read();code=process.wait()
    if code not in (0,1):raise ValueError('Cannot read installer entry: '+name)
    if size!=(app/name).stat().st_size or checksum.hexdigest()!=digest_file(app/name):
        raise ValueError('Installer contains stale application payload: '+name)
result={'version':version,'zip_matches_unpacked':True,'setup_payload_matches_unpacked':True,'engine_matches_latest_build':True,'user_data_included':False,'files':[{'name':file.name,'bytes':file.stat().st_size,'sha256':digest_file(file)} for file in [setup,release/f'ICE-Loop-Studio-{version}-x64.zip']]}
(root/'.test-tmp/release-binary-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
