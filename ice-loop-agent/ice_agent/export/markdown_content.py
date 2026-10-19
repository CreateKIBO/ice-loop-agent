"""CommonMark export transformations; executable examples are never rewritten."""
from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import unquote

from markdown_it import MarkdownIt

_SLOT = re.compile(r'^!\[图(\d+)：(.+?)\]\(待配图：(.+?)｜(.+?)\)\s*$')
_RUN = re.compile(r'^<!--RUN_OUTPUT:(run-[A-Za-z0-9_-]+)-->\s*$')
_RUN_REF = re.compile(r'^<!--RUN_REF:(run-[A-Za-z0-9_-]+)\|([a-f0-9]{12})-->\s*$')


def _parser():
    # HTML is tokenized, never rendered or executed. No network/linkify plugin.
    return MarkdownIt('commonmark', {'html':True, 'maxNesting':64}).enable(['table','strikethrough'])


def _children(tokens):
    for token in tokens:
        yield token
        if token.children:
            yield from _children(token.children)


def _source(token, lines):
    return ''.join(lines[slice(*token.map)]) if token.map else ''


class _HTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text=[]; self.images=[]; self.hidden=0

    def handle_starttag(self, tag, attrs):
        values=dict(attrs)
        if tag in ('script','style'):
            self.hidden+=1
        if tag=='img':
            self.images.append({'caption':values.get('alt') or 'HTML图片', 'source':values.get('src') or values.get('srcset') or ''})
        if not self.hidden and tag in ('br','p','div','tr','li'):
            self.text.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script','style'):
            self.hidden=max(0,self.hidden-1)
        if not self.hidden and tag in ('p','div','tr','li'):
            self.text.append('\n')

    def handle_data(self, data):
        if not self.hidden:self.text.append(data)


def unmanaged_images(markdown: str) -> list[dict]:
    """All images except standalone managed figure placeholders, including refs/HTML."""
    lines=markdown.splitlines(keepends=True)
    tokens=_parser().parse(markdown)
    managed=set()
    for token in tokens:
        if token.type=='inline' and _SLOT.fullmatch(_source(token,lines).strip()):
            managed.update(id(child) for child in token.children or [] if child.type=='image')
    result=[]
    for token in _children(tokens):
        if token.type=='image' and id(token) not in managed:
            result.append({'caption':token.content,'source':token.attrGet('src') or ''})
        elif token.type in ('html_inline','html_block'):
            html=_HTML();html.feed(token.content);result.extend(html.images)
    return result


def managed_placeholders(markdown: str) -> list[dict]:
    lines=markdown.splitlines(keepends=True);result=[]
    for token in _parser().parse(markdown):
        slot=_SLOT.fullmatch(_source(token,lines).strip()) if token.type=='inline' else None
        if slot:result.append({'figure_no':int(slot[1]),'caption':slot[2]})
    return result


def run_references(markdown: str) -> list[str]:
    return [match[1] for token in _parser().parse(markdown) if token.type=='html_block'
            and (match:=_RUN.fullmatch(token.content.strip()))]


def program_fences(markdown: str) -> list[dict]:
    from ..domain.types import sha256_text
    return [{'language':token.info.split()[0].lower(),'code_sha256':sha256_text(token.content)}
            for token in _parser().parse(markdown) if token.type=='fence' and token.info.split()
            and token.info.split()[0].lower() in ('python','py','java')]


def output_reference_errors(markdown: str, runs: dict) -> list[str]:
    """Validate explicit workflow output anchors against their preceding text block."""
    tokens=_parser().parse(markdown);errors=[]
    for index,token in enumerate(tokens):
        ref=_RUN_REF.fullmatch(token.content.strip()) if token.type=='html_block' else None
        if not ref:continue
        record=next((record for key,record in runs.items() if key==ref[1] or record.get('run_id')==ref[1]),None)
        previous=tokens[index-1] if index else None
        valid=record and str(record.get('output_sha256','')).startswith(ref[2]) and previous and previous.type=='fence' and previous.info.strip()=='text'
        if valid:
            expected=record.get('stdout','').replace('\r\n','\n').rstrip('\n')
            if record.get('stderr','').strip():expected+='\n\n[stderr]\n'+record['stderr'].replace('\r\n','\n').rstrip('\n')
            valid=previous.content.rstrip('\n')==expected
        if not valid:errors.append(ref[1])
    return errors


def run_text(record: dict) -> str:
    stdout=record.get('stdout','');stderr=record.get('stderr','')
    if not isinstance(stdout,str) or not isinstance(stderr,str):
        raise ValueError('运行输出格式无效，请重新运行后导出')
    if not stderr:return stdout
    return stdout+('' if not stdout or stdout.endswith('\n') else '\n')+'[stderr]\n'+stderr


def export_markdown(markdown: str, names: dict[int,str], runs: dict | None = None,
                    statuses: dict | None = None) -> str:
    """Use source spans, preserving all other original bytes, fences and whitespace."""
    lines=markdown.splitlines(keepends=True)
    offsets=[0]
    for line in lines:offsets.append(offsets[-1]+len(line))
    edits=[]
    for token in _parser().parse(markdown):
        if not token.map:continue
        source=_source(token,lines)
        replacement=None
        if token.type=='inline':
            slot=_SLOT.fullmatch(source.strip())
            if slot and int(slot[1]) in names:
                caption=slot[2].replace('\\','\\\\').replace('[','\\[').replace(']','\\]')
                replacement=f'![图{slot[1]}：{caption}](../图片/{names[int(slot[1])]})'
        elif token.type=='html_block':
            ref=_RUN.fullmatch(source.strip())
            if ref and runs and ref[1] in runs and (statuses or {}).get(ref[1],{}).get('ok'):
                output=run_text(runs[ref[1]])
                fence='`'*max(3,max((len(part)+1 for part in re.findall(r'`+',output)),default=3))
                replacement=fence+'text\n'+output+('' if output.endswith('\n') else '\n')+fence
        if replacement is not None:
            ending='\r\n' if source.endswith('\r\n') else '\n' if source.endswith('\n') else ''
            edits.append((offsets[token.map[0]],offsets[token.map[1]],replacement+ending))
    for start,end,replacement in reversed(edits):
        markdown=markdown[:start]+replacement+markdown[end:]
    return markdown


def _inline(tokens) -> str:
    result=[];links=[]
    for token in tokens or []:
        kind=token.type
        if kind in ('text','code_inline'):result.append(token.content)
        elif kind in ('softbreak','hardbreak'):result.append('\n')
        elif kind=='link_open':links.append(token.attrGet('href') or '')
        elif kind=='link_close':
            # Preserve destinations in plain text rather than silently dropping them.
            if links:result.append('（'+links.pop()+'）')
        elif kind=='image':
            src=token.attrGet('src') or ''
            decoded=unquote(src)
            if decoded.startswith('../图片/'):
                result.append('['+(token.content or '图片')+'——见 '+decoded[3:]+']')
            else:result.append('['+(token.content or '图片')+'——'+decoded+']')
        elif kind in ('html_inline','html_block'):
            html=_HTML();html.feed(token.content);result.append(''.join(html.text))
    return ''.join(result)


def plain_text(markdown: str) -> str:
    """Render Markdown tokens as text; literal code and outputs retain their contents."""
    result=[];lists=[];table_cell=0
    for token in _parser().parse(markdown):
        kind=token.type
        if kind=='inline':result.append(_inline(token.children))
        elif kind in ('fence','code_block'):
            result.append(token.content+('' if token.content.endswith('\n') else '\n')+'\n')
        elif kind in ('bullet_list_open','ordered_list_open'):
            lists.append({'ordered':kind=='ordered_list_open','next':int(token.attrGet('start') or 1)})
        elif kind in ('bullet_list_close','ordered_list_close'):
            lists.pop();result.append('\n')
        elif kind=='list_item_open':
            item=lists[-1];result.append('  '*(len(lists)-1)+(str(item['next'])+'. ' if item['ordered'] else '• '));item['next']+=1
        elif kind=='list_item_close':result.append('\n')
        elif kind in ('paragraph_close','heading_close','blockquote_close'):result.append('\n' if lists else '\n\n')
        elif kind=='hr':result.append('———\n\n')
        elif kind=='tr_open':table_cell=0
        elif kind in ('th_open','td_open'):
            if table_cell:result.append('\t')
            table_cell+=1
        elif kind in ('tr_close','table_close'):result.append('\n')
        elif kind=='html_block':
            ref=_RUN.fullmatch(token.content.strip())
            if ref:result.append('[运行输出待解析：'+ref[1]+']\n\n')
            else:
                html=_HTML();html.feed(token.content);result.append(''.join(html.text)+'\n')
    return ''.join(result).strip('\n')+'\n'
