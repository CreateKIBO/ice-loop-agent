import json
import tarfile
import re
import posixpath
from pathlib import Path

root = Path(__file__).resolve().parent.parent
folder = root / '.test-tmp' / 'component-tarballs'
for record in json.loads((folder / 'manifest.json').read_text()):
    target = root / 'desktop' / 'node_modules' / record['name']
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(record['file'], 'r:gz') as archive:
        members = {m.name: m for m in archive.getmembers()}
        wanted = set(members)
        if record['name'] == '@shoelace-style/shoelace':
            wanted = {'package/package.json','package/LICENSE.md','package/dist/themes/light.css'}
            pending = ['package/dist/components/'+name+'/'+name+'.js' for name in ('split-panel','tab-group','tab','tab-panel')]
            while pending:
                name = pending.pop()
                if name in wanted:
                    continue
                wanted.add(name)
                content = archive.extractfile(members[name]).read().decode('utf-8')
                for relative in re.findall(r'(?:from|import)\s*[\"\'](\.[^\"\']+)[\"\']',content):
                    dependency = posixpath.normpath(posixpath.join(posixpath.dirname(name),relative))
                    if dependency in members:
                        pending.append(dependency)
        elif record['name'] == 'lucide':
            wanted = {'package/package.json','package/LICENSE','package/dist/umd/lucide.js'}
        else:
            wanted = {name for name in members if name.endswith(('.js','.json','.exe')) or '/LICENSE' in name}
        for name in sorted(wanted):
            member = members[name]
            parts = Path(member.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or member.issym() or member.islnk():
                raise ValueError('invalid pinned package archive')
            destination = target.joinpath(*parts[1:])
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.extractfile(member).read())
    print(record['name'], 'extracted', flush=True)
