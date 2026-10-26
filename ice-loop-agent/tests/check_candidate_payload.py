"""Stream audit ZIP and installer payloads, never extract into user folders."""
import hashlib, json, os, stat, subprocess, sys, zipfile
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
root=Path(sys.argv[1]).resolve()
if not root.is_relative_to(repo/'.test-tmp/candidates'):raise ValueError('unowned candidate')
marker=json.loads((root/'CANDIDATE.json').read_text(encoding='utf-8'))
assert marker['project']==str(repo) and marker['state']=='built' and not marker['source_changes']
app=root/'release/win-unpacked'
def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
forbidden={'app.db','settings.json','credentials.json','secrets.json','Cookies','Local State','.env'}
files={p.relative_to(app).as_posix():p for p in app.rglob('*') if p.is_file()}
for name,p in files.items():
    assert p.name not in forbidden,name
    assert '/.test-tmp/' not in '/'+name and '/.desktop-runtime/' not in '/'+name,name
    assert not (p.suffix in ('.pyc','.pyo') and '__pycache__' in p.parts),name
archive=root/'release'/f"ICE-Loop-Studio-{marker['version']}-x64.zip"
with zipfile.ZipFile(archive) as zipped:
    entries={}
    for entry in zipped.infolist():
        if entry.is_dir():continue
        name=entry.filename.replace('\\','/')
        assert not name.startswith('/') and '..' not in Path(name).parts and ':' not in name,name
        assert not stat.S_ISLNK(entry.external_attr >> 16),name
        assert name not in entries,name
        entries[name]=entry
    # NSIS copies its elevate helper after the ZIP target may have archived the app.
    # Permit only that exact builder-owned file, and verify it against the cached binary.
    missing=set(files)-set(entries)
    assert not (set(entries)-set(files)), sorted(set(entries)-set(files))
    assert missing in (set(), {'resources/elevate.exe'}), sorted(missing)
    if missing:
        helpers=list((root/'cache/builder/nsis').glob('*/elevate.exe'))
        assert any(sha(helper)==sha(files['resources/elevate.exe']) for helper in helpers), 'Unknown elevation helper'
    zip_file_count=len(entries)
    for name,entry in entries.items():
        with zipped.open(entry) as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
        assert digest==sha(files[name]),name
install_manifest=json.loads((root/'release/install-files.json').read_text(encoding='utf-8'))
assert install_manifest['schema']==1
owned={row['path']:row for row in install_manifest['files']}
assert len(owned)==len(install_manifest['files']) and set(files)<=set(owned)
for name,payload in files.items():
    assert owned[name]['bytes']==payload.stat().st_size and owned[name]['sha256']==sha(payload),name
assert set(owned)-set(files)<= {'resources/elevate.exe'}
# Programmatic config objects can merge extraResources arrays with the default config.
# Require every resource byte to originate from THIS candidate, not a prior global dist.
resource_origins={}
for source_name,target_name in [('ice-engine','engine'),('teaching-python','teaching-python'),('engine-project','engine-project')]:
    source_dir=root/'dist'/source_name
    target_dir=app/'resources'/target_name
    source_files={p.relative_to(source_dir).as_posix():p for p in source_dir.rglob('*') if p.is_file()}
    target_files={p.relative_to(target_dir).as_posix():p for p in target_dir.rglob('*') if p.is_file()}
    assert set(source_files)==set(target_files),('resource origin paths',source_name)
    for name,p in source_files.items():
        assert sha(p)==sha(target_files[name]),('resource origin bytes',source_name,name)
    resource_origins[source_name]=len(source_files)

visual=[]
for p in (repo/'ice_agent/resources/visual_presets/ice-loop').glob('*.png'):
    target=app/'resources/engine/_internal/ice_agent/resources/visual_presets/ice-loop'/p.name
    assert target.is_file() and sha(target)==sha(p),p.name
    visual.append(p.name)
assert len(visual)==7,len(visual)
setup=root/'release'/f"ICE-Loop-Studio-{marker['version']}-Setup.exe"
selected=['ICE Loop Studio.exe','resources/app.asar','resources/engine/ice-engine.exe','resources/teaching-python/python.exe','resources/engine-project/BUILD.json']
installer_checked=[]
if setup.is_file():
    seven=repo/'desktop/node_modules/7zip-bin/win/x64/7za.exe'
    for name in selected:
        process=subprocess.Popen([str(seven),'e',str(setup),name,'-so'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        digest=hashlib.sha256();size=0
        for chunk in iter(lambda:process.stdout.read(1024*1024),b''):digest.update(chunk);size+=len(chunk)
        error=process.stderr.read();code=process.wait()
        assert code in (0,1) and size==files[name].stat().st_size and digest.hexdigest()==sha(files[name]),(name,code,size,error[:120])
        installer_checked.append(name)
result={'state':'passed','root':str(root),'zip_file_count':zip_file_count,'nsis_only_files':sorted(missing),'all_zip_bytes_match':True,'engine_matches_build':True,'resource_origin_files':resource_origins,'embedded_install_manifest_matches_payload':True,'visual_assets_unchanged':visual,'installer_entries_checked':installer_checked,'private_filenames_absent':True,'files':[{'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p)} for p in [archive,setup] if p.is_file()]}
(root/'payload-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
