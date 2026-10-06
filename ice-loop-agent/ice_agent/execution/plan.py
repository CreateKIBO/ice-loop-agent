"""One execution manifest shared by preflight, review UI and the actual worker."""
from __future__ import annotations

import ast
import re
from collections import Counter

from ..domain.types import sha256_json, sha256_text
from ..llm import mockgen
from ..rules import parse_markdown
from ..rules.structural import executable_code_blocks


def execution_hash(state: dict) -> str:
    payload={'draft':state.get('draft_md',''),'stdin':state['spec'].get('stdin_by_filename',{})}
    if 'execution_mode' in state['spec']:
        payload['execution']={'mode':state['spec']['execution_mode'],'images':state['spec'].get('container_images',{})}
    if 'expected_failures' in state['spec']:payload['expected_failures']=state['spec']['expected_failures']
    return sha256_json(payload)


def input_calls(source: str, language: str) -> int:
    if language == 'python':
        try:
            tree=ast.parse(source)
        except SyntaxError:
            return 0
        return sum(isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='input' for node in ast.walk(tree))
    if language == 'java' and re.search(r'new\s+Scanner\s*\(\s*System\.in\s*\)',source):
        return max(1,len(re.findall(r'\.next(?:Line|Int|Double|Float|Long|Short|Byte|Boolean)?\s*\(',source)))
    return 0


def execution_plan(state: dict) -> dict:
    from ..workflow.nodes import canon_filename
    spec=state['spec'];canon={row['filename']:row for row in mockgen.canon_code(state.get('series',spec['series']),spec['episode'])}
    blocks=[]
    for index,block in enumerate(executable_code_blocks(parse_markdown(state.get('draft_md',''))),1):
        source='\n'.join(block.lines)+'\n';language=(block.lang or 'python').lower()
        language={'py':'python','python3':'python'}.get(language,language)
        java_class=re.search(r'public\s+class\s+(\w+)',source) if language=='java' else None
        filename=(java_class[1]+'.java' if java_class else f'Demo_{index}.java') if language=='java' else canon_filename(canon,index,source)
        blocks.append({'index':index,'language':language,'filename':filename,'source':source,
                       'code_sha256':sha256_text(source),'input_calls':input_calls(source,language)})
    counts=Counter(row['filename'] for row in blocks);inputs=spec.get('stdin_by_filename',{}) or {}
    for row in blocks:
        filename=row['filename'];key=f'code_{row["index"]}_{filename}' if counts[filename]>1 else filename
        raw=inputs.get(key)
        if raw is None and filename in canon and canon[filename]['code'].strip()==row['source'].strip():
            raw=canon[filename].get('stdin','')
        raw=raw or ''
        events=[line+'\n' for line in raw.splitlines()] if isinstance(raw,str) else list(raw)
        row.update(stdin_key=key,stdin_text=raw if isinstance(raw,str) else ''.join(raw),stdin_events=events,
                   stdin_hash=sha256_json(events),needs_input=bool(row['input_calls'] and not events),expected_failure=bool(spec.get('expected_failures',{}).get(str(row['index']),False)))
    content_hash=execution_hash(state)
    approved=bool(spec.get('approve_local_exec')) or state.get('execution_approval')==content_hash
    missing=[row['stdin_key'] for row in blocks if row['needs_input']]
    return {'content_hash':content_hash,'approved':approved,'missing_inputs':missing,'blocks':blocks,
            'mode':spec.get('execution_mode','local_reviewed'),'images':spec.get('container_images',{}),
            'status':'needs_input' if missing else 'needs_approval' if blocks and not approved else 'ready' if blocks else 'no_code'}


def validate_inputs(inputs: object) -> dict:
    if not isinstance(inputs,dict) or len(inputs)>32 or any(
        not isinstance(name,str) or not re.fullmatch(r'[\w.-]{1,160}',name) or name in ('.','..') or
        not isinstance(value,str) or len(value)>4000 or '\x00' in value for name,value in inputs.items()):
        raise ValueError('示例输入需为代码文件键到文本的对象，每段最多4000字，不能包含路径或空字符')
    return inputs
