"""Account-scoped editorial schedules; deterministic document import, no model calls."""
from __future__ import annotations

import hashlib
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .domain.types import new_id, now_iso, sha256_json, sha256_text

FIELDS = ('series','episode','title','content_angle','core_benefit','next_episode_plan')
ALIASES = {'栏目':'series','期号':'episode','期数':'episode','标题':'title','题目':'title','选题':'title',
           '内容要点':'content_angle','要点':'content_angle','内容角度':'content_angle',
           '读者收益':'core_benefit','读者能带走什么':'core_benefit',
           '下一期预告':'next_episode_plan','下期预告':'next_episode_plan'}


def read_document(file: Path) -> dict[str,str]:
    if file.suffix.lower() not in ('.md','.txt','.docx') or not file.is_file():
        raise ValueError('请选择Markdown、TXT或DOCX选题大纲')
    with file.open('rb') as stream:raw=stream.read(2000001)
    if len(raw)>2000000:raise ValueError('大纲文档不能超过2MB')
    if file.suffix.lower()=='.docx':
        import io
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                matches=[info for info in archive.infolist() if info.filename=='word/document.xml']
                if len(matches)!=1 or matches[0].file_size>2000000:
                    raise ValueError('Word正文缺失、重复或超过2MB')
                xml=archive.read(matches[0])
            if b'\x00' in xml or b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
                raise ValueError('Word正文包含不支持的XML实体')
            root=ET.fromstring(xml);ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            if root.findall('.//w:ins',ns) or root.findall('.//w:del',ns):
                raise ValueError('Word包含未处理的修订，请接受/拒绝修订后重新导入')
            body=root.find('w:body',ns)
            if body is None:raise ValueError('Word没有可读取的正文')
            lines=[]
            for child in body:
                if child.tag.endswith('}p'):
                    lines.append(''.join(node.text or '' for node in child.findall('.//w:t',ns)))
                elif child.tag.endswith('}tbl'):
                    for row in child.findall('w:tr',ns):
                        cells=[''.join(node.text or '' for node in cell.findall('.//w:t',ns)) for cell in row.findall('w:tc',ns)]
                        lines.append('| '+' | '.join(cells)+' |')
            text='\n'.join(lines)
        except (zipfile.BadZipFile,KeyError,ET.ParseError,RuntimeError,NotImplementedError) as exc:
            raise ValueError('DOCX结构损坏，无法读取选题大纲') from exc
    else:
        try:text=raw.decode('utf-8-sig')
        except UnicodeError:
            try:text=raw.decode('gb18030')
            except UnicodeError as exc:raise ValueError('请保存为UTF-8文本后再导入') from exc
    if len(text)>400000:raise ValueError('大纲正文不能超过400000字符')
    return {'text':text,'source_name':file.name,'file_hash':hashlib.sha256(raw).hexdigest()}


def example(account: dict) -> str:
    first=account['columns'][0];second=account['columns'][1] if len(account['columns'])>1 else None
    text=(f'# {account["name"]} 栏目选题大纲\n\n## {first["code"]} · {first["name"]}\n\n'
          '### 第001期：从第一个小作品开始\n内容要点：介绍起步方法，用一个可运行的作品验证。\n'
          '读者收益：完成自己的第一个作品。\n下一期预告：认识最常用的基础概念。\n\n'
          '### 第011期：把前面的知识串起来\n内容要点：回顾已有知识，完成一个阶段项目。\n\n'
          '### 第100期：回顾作品并继续改进\n内容要点：从真实使用反馈中选择下一步。\n')
    if second:
        text+=f'\n## {second["code"]} · {second["name"]}\n\n| 期号 | 标题 | 内容要点 |\n|---|---|---|\n| 1 | 起步前先准备好工具 | 整理环境与验证步骤。 |\n'
    return text


def validate(row: dict, account: dict) -> dict:
    if not isinstance(row,dict):raise ValueError('选题条目必须是对象')
    series=row.get('series');episode=row.get('episode')
    if series not in {col['code'] for col in account['columns']}:
        raise ValueError('请给每条题目选择当前公众号的栏目')
    if type(episode) is not int or not 1<=episode<=9999:raise ValueError('期号需为1–9999，不限十篇')
    result={'series':series,'episode':episode}
    for key,limit in [('title',30),('content_angle',300),('core_benefit',1000),('next_episode_plan',1000)]:
        value=row.get(key,'')
        if not isinstance(value,str) or len(value)>limit or '\x00' in value or (key=='title' and any(c in value for c in '\r\n')):
            raise ValueError(f'{key}格式无效或超过{limit}字')
        result[key]=value.strip()
    if not result['title']:raise ValueError('标题不能为空')
    return result


def parse_text(text: str, account: dict) -> dict[str,Any]:
    if not isinstance(text,str) or not text.strip() or len(text)>400000:
        raise ValueError('请填写不超过400000字符的选题大纲')
    columns={col['code']:col['code'] for col in account['columns']}
    names={col['name']:col['code'] for col in account['columns']}
    series='';rows=[];current=None;table=None;ignored=[]
    code_pattern='|'.join(re.escape(code) for code in columns)
    for line_no,raw in enumerate(text.splitlines(),1):
        line=raw.strip()
        if not line:continue
        clean=re.sub(r'^\s*(?:#{1,6}\s*|[-*]\s+)', '',line).strip().strip('*').strip()
        header=re.match(r'^(?:栏目\s*[:：]\s*)?('+code_pattern+r')(?:\s*[·：:—-]\s*.*|\s+[^\d/／].*)?$',clean)
        if header or clean in names:
            series=header[1] if header else names[clean];current=None;table=None;continue
        explicit=re.match(r'^('+code_pattern+r')\s*[/／]\s*(\d{1,4})\s*[:：.、—-]?\s*(.*)$',clean)
        numbered=re.match(r'^(?:第\s*)?(\d{1,4})\s*(?:期|篇|[.、])\s*[:：.、—-]?\s*(.*)$',clean)
        if explicit or numbered:
            match=explicit or numbered
            row={'series':match[1] if explicit else series,'episode':int(match[2] if explicit else match[1]),
                 'title':(match[3] if explicit else match[2]).strip().strip('《》'),
                 'content_angle':'','core_benefit':'','next_episode_plan':'','source_line':line_no}
            rows.append(row);current=row;table=None;continue
        if line.startswith('|') and line.endswith('|'):
            cells=[cell.strip() for cell in line[1:-1].split('|')]
            keys=[ALIASES.get(cell.strip('*')) for cell in cells]
            if 'episode' in keys and 'title' in keys:
                table=keys;current=None;continue
            if all(re.fullmatch(r':?-+:?',cell) for cell in cells):continue
            if table and len(cells)==len(table):
                values={key:value for key,value in zip(table,cells) if key};number=values.get('episode','')
                if re.fullmatch(r'(?:第\s*)?\d{1,4}\s*期?',number):
                    row={key:values.get(key,'') for key in FIELDS};row['series']=row['series'] or series
                    row['episode']=int(re.search(r'\d+',number)[0]);row['source_line']=line_no
                    rows.append(row);current=row;continue
        field=re.match(r'^([^:：]{1,14})\s*[:：]\s*(.*)$',clean)
        if field and current and ALIASES.get(field[1].strip()) in ('title','content_angle','core_benefit','next_episode_plan'):
            current[ALIASES[field[1].strip()]]=field[2].strip();continue
        if not clean.endswith('选题大纲'):ignored.append(line_no)
    if len(rows)>1000:raise ValueError('单次导入最多1000条，请分批导入；每栏目没有十篇限制')
    errors=[];seen=set()
    for row in rows:
        try:
            validate(row,account);key=(row['series'],row['episode'])
            if key in seen:raise ValueError('同一栏目同一期号重复，请修改或移除重复行')
            seen.add(key)
        except ValueError as exc:errors.append(f'第{row["source_line"]}行：{exc}')
    return {'rows':rows,'errors':errors,'ignored_lines':ignored}


class EditorialTopics:
    def __init__(self, store: Any, account: dict):self.store,self.account=store,account

    def list(self) -> list[dict]:
        rows=self.store.conn.execute('SELECT * FROM editorial_topics WHERE account_id=? ORDER BY series,episode',(self.account['id'],)).fetchall()
        return [{**dict(row),'content_hash':sha256_json(dict(row))} for row in rows]

    def base_hash(self) -> str:
        # Same canonical JSON bytes as the original list-based fingerprint,
        # without retaining every topic's long notes just to hash them.
        import json
        hasher=hashlib.sha256()
        hasher.update(('{"columns": '+json.dumps(self.account['columns'],ensure_ascii=False,sort_keys=True)+', "rows": [').encode('utf-8'))
        separator=''
        for row in self.store.conn.execute('SELECT * FROM editorial_topics WHERE account_id=? ORDER BY series,episode',(self.account['id'],)):
            value={**dict(row),'content_hash':sha256_json(dict(row))}
            hasher.update((separator+json.dumps(value,ensure_ascii=False,sort_keys=True)).encode('utf-8'))
            separator=', '
        hasher.update(b']}')
        return hasher.hexdigest()

    def get(self, topic_id: str) -> dict:
        row=self.store.conn.execute('SELECT * FROM editorial_topics WHERE topic_id=? AND account_id=?', (topic_id,self.account['id'])).fetchone()
        if not row:raise ValueError('选题不存在或不属于当前公众号')
        return {**dict(row),'content_hash':sha256_json(dict(row))}

    def page(self, params):
        from .paging import page_request, page_bounds
        size,page,series,query=page_request(params,{c['code'] for c in self.account['columns']})
        args=(self.account['id'],series,series,query,query)
        with self.store.transaction():
            total=self.store.conn.execute("SELECT COUNT(*) FROM editorial_topics WHERE account_id=? AND (?='' OR series=?) AND (?='' OR instr(lower(title)||' '||CAST(episode AS TEXT),lower(?))>0)",args).fetchone()[0]
            page,pages=page_bounds(total,page,size)
            rows=self.store.conn.execute("SELECT * FROM editorial_topics WHERE account_id=? AND (?='' OR series=?) AND (?='' OR instr(lower(title)||' '||CAST(episode AS TEXT),lower(?))>0) ORDER BY series,episode,topic_id LIMIT ? OFFSET ?",(*args,size,page*size)).fetchall()
        return {'rows':[{**dict(row),'content_hash':sha256_json(dict(row))} for row in rows],
                'total':total,'page':page,'pages':pages,'page_size':size,'example':example(self.account)}

    def preview(self, params: dict) -> dict:
        text=params.get('text','');name=params.get('source_name','手动粘贴')
        if not isinstance(name,str) or not name.strip() or len(name)>200:raise ValueError('来源名称需为1–200字')
        parsed=parse_text(text,self.account);base=self.base_hash()
        rows=[]
        for row in parsed['rows']:
            prior=self.store.conn.execute('SELECT * FROM editorial_topics WHERE account_id=? AND series=? AND episode=?',
                                          (self.account['id'],row['series'],row['episode'])).fetchone()
            existing={**dict(prior),'content_hash':sha256_json(dict(prior))} if prior else None
            rows.append({**row,'existing':existing})
        return {**parsed,'rows':rows,'base_hash':base,'source_name':name,
                'preview_hash':sha256_json({'account':self.account['id'],'base':base,'name':name,'text':text})}

    def save(self, params: dict) -> dict:
        if type(params.get('return_rows', True)) is not bool:raise ValueError('返回清单选项应为布尔值')
        preview=self.preview(params)
        if preview['preview_hash']!=params.get('preview_hash') or preview['base_hash']!=params.get('base_hash'):
            raise ValueError('文档、栏目或已存选题变化，请重新解析预览')
        raw=params.get('rows')
        if not isinstance(raw,list) or not 1<=len(raw)<=1000:raise ValueError('请选择1–1000条选题后保存')
        rows=[validate(row,self.account) for row in raw]
        if len({(row['series'],row['episode']) for row in rows})!=len(rows):raise ValueError('同一栏目同一期号重复')
        with self.store.transaction():
            if self.base_hash()!=preview['base_hash']:raise ValueError('选题已变化，请重新预览')
            for row in rows:
                existing=self.store.conn.execute('SELECT * FROM editorial_topics WHERE account_id=? AND series=? AND episode=?',
                                                 (self.account['id'],row['series'],row['episode'])).fetchone()
                if existing and any(existing[key]!=row[key] for key in FIELDS) and params.get('replace_existing') is not True:
                    raise ValueError(f'{row["series"]}/{row["episode"]}已有题目，请确认覆盖已有期的选题')
                self.store.conn.execute('INSERT INTO editorial_topics VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,series,episode) DO UPDATE SET title=excluded.title,content_angle=excluded.content_angle,core_benefit=excluded.core_benefit,next_episode_plan=excluded.next_episode_plan,source_name=excluded.source_name,updated_at=excluded.updated_at',
                    (existing['topic_id'] if existing else new_id('editorial'),self.account['id'],row['series'],row['episode'],row['title'],row['content_angle'],row['core_benefit'],row['next_episode_plan'],preview['source_name'],now_iso()))
            self.store.conn.execute('INSERT INTO editorial_topic_imports VALUES (?,?,?,?,?,?)',
                (new_id('import'),self.account['id'],preview['source_name'],params['text'],sha256_text(params['text']),now_iso()))
        return {'saved':len(rows),'rows':self.list() if params.get('return_rows',True) else []}

    def update(self, params: dict) -> dict:
        with self.store.transaction():
            old=self.get(params.get('topic_id'))
            if old['content_hash']!=params.get('content_hash'):raise ValueError('选题已变化，请重新打开')
            if params.get('delete') is True:
                self.store.conn.execute('DELETE FROM editorial_topics WHERE topic_id=? AND account_id=?',(old['topic_id'],self.account['id']))
            else:
                row=validate(params,self.account)
                if self.store.conn.execute('SELECT 1 FROM editorial_topics WHERE account_id=? AND series=? AND episode=? AND topic_id!=?',
                                           (self.account['id'],row['series'],row['episode'],old['topic_id'])).fetchone():
                    raise ValueError('该栏目期号已有选题，请修改期号')
                self.store.conn.execute('UPDATE editorial_topics SET series=?,episode=?,title=?,content_angle=?,core_benefit=?,next_episode_plan=?,updated_at=? WHERE topic_id=?',
                    (*(row[key] for key in FIELDS),now_iso(),old['topic_id']))
        return {'ok':True}

    def match(self, series: str, episode: int, *, include_available: bool = True) -> dict:
        if series not in {col['code'] for col in self.account['columns']} or type(episode) is not int or not 1<=episode<=9999:
            raise ValueError('请选择栏目与1–9999期号')
        if type(include_available) is not bool:raise ValueError('候选清单选项应为布尔值')
        with self.store.transaction():
            found=self.store.conn.execute('SELECT * FROM editorial_topics WHERE account_id=? AND series=? AND episode=?',(self.account['id'],series,episode)).fetchone()
            following=self.store.conn.execute('SELECT title FROM editorial_topics WHERE account_id=? AND series=? AND episode=?',(self.account['id'],series,episode+1)).fetchone()
            row={**dict(found),'content_hash':sha256_json(dict(found))} if found else None
            # The classic selector needs all title identities, not all topic text.
            available=[]
            if include_available:
                for item in self.store.conn.execute('SELECT * FROM editorial_topics WHERE account_id=? AND series=? ORDER BY episode',(self.account['id'],series)):
                    available.append({**{key:item[key] for key in ('topic_id','episode','title')},'content_hash':sha256_json(dict(item))})
        return {'topic':row,'next_title':following['title'] if following else '', 'available':available}


def locked_title_payload(spec: dict) -> dict:
    selection=spec.get('title_selection') or {}
    if not selection.get('locked') or selection.get('title')!=spec.get('topic') or not spec.get('publication_confirmation'):
        raise ValueError('缺少对应的人工标题确认记录')
    return {'candidates':[{'title':selection['title'],'mechanism':'预设大纲题目' if selection['mode']=='outline' else '人工确认题目'}],
            'recommended':0,'recommend_reason':'新建文章时已审阅并确认该标题，后续不调用AI重新拟题。'}
