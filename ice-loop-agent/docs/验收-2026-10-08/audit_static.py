from __future__ import annotations
import ast
import json
import re
import sys
from pathlib import Path
repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo))
main_path = repo / 'desktop/main.cjs'
main_text = main_path.read_text(encoding='utf-8')
start = main_text.index('const methods =')
end = main_text.index('function engineCommand', start)
allow = {token for token in main_text[start:end].split("'")[1::2] if all(part.isidentifier() for part in token.split("."))}
# 字面量AST提取后端Handler方法，绝不执行main.cjs/Electron。
registered = {}
for file in (repo/'ice_agent/application').glob('*.py'):
    tree=ast.parse(file.read_text(encoding='utf-8-sig'))
    for cls in (node for node in ast.walk(tree) if isinstance(node,ast.ClassDef)):
        for node in cls.body:
            if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='METHODS' for t in node.targets):
                if isinstance(node.value,ast.Call) and node.value.args:
                    try: methods=ast.literal_eval(node.value.args[0])
                    except (ValueError,TypeError): continue
                    for name in methods:
                        registered[name]={'file':file.relative_to(repo).as_posix(),'line':node.lineno}
missing = {name:location for name,location in sorted(registered.items()) if name not in allow}
frontend = {}
for file in (repo/'desktop/ui/src').rglob('*'):
    if file.suffix in ('.ts','.tsx') and '/contracts/' not in file.as_posix():
        for number,line in enumerate(file.read_text(encoding='utf-8').splitlines(),1):
            for name in re.findall(r'"([a-z_]+\.[a-z_]+)"',line):
                if name in registered:
                    frontend.setdefault(name,[]).append({'file':file.relative_to(repo).as_posix(),'line':number,'blocked':name in missing})
result={'application_methods':len(registered),'main_allowlist_methods':len(allow),'missing_methods_count':len(missing),'missing_methods':missing,'frontend_calls':frontend}
(repo/'docs/验收-2026-10-08/rpc-coverage.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'registered':len(registered),'blocked':len(missing),'ui_used_blocked':sorted(k for k in frontend if k in missing)},ensure_ascii=False))
