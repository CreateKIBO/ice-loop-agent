"""Image-only jobs: immutable source, editable figure plan, separate exports."""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .domain.types import RunSpec, new_id, now_iso, sha256_json, sha256_text
from .paths import assert_within, atomic_write_text, normalize
from .providers.tapnow import selected_asset, validate_image_file


def parse_source(body: str) -> dict[str, Any]:
    images, codes, anchors = [], [], [{'id':'end','label':'文章结尾','offset':len(body)}]
    offset, fence, code_lines, code_language = 0, None, [], ''
    title, publication = '', None
    for line in body.splitlines(keepends=True):
        text = line.rstrip('\r\n')
        marker = re.match(r'^\s*(`{3,}|~{3,})(.*)$', text)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                if code_language in ('python','python3','java'):
                    source = '\n'.join(code_lines) + '\n'
                    language = 'java' if code_language == 'java' else 'python'
                    match = re.search(r'public\s+class\s+([A-Za-z_$][\w$]*)', source) if language=='java' else None
                    filename = (match[1]+'.java') if match else f'snippet_{len(codes)+1}.'+('java' if language=='java' else 'py')
                    codes.append({'index':len(codes),'language':language,'source':source,'filename':filename,
                                  'code_sha256':sha256_text(source)})
                fence, code_lines = None, []
            else:
                code_lines.append(text)
        elif marker:
            fence, code_language = marker[1], marker[2].strip().lower()
        else:
            heading = re.match(r'^(#{1,3})\s+(.+?)\s*#*\s*$', text)
            if heading:
                if len(heading[1]) == 1 and not title:
                    title = heading[2]
                    publication = re.match(r'^\s*[【\[]?([A-Za-z][A-Za-z0-9_-]{0,15})\s*/\s*(\d{1,4})\b', title)
                    anchors.insert(0, {'id':'intro','label':'标题之后','offset':offset+len(line)})
                elif len(heading[1]) > 1:
                    anchors.append({'id':f'heading-{offset}','label':heading[2][:100]+'之前','offset':offset})
            image = re.match(r'^\s*!\[(.*?)\]\(([^)]*)\)\s*$', text)
            if image:
                images.append({'alt':image[1], 'reference':image[2], 'start':offset,
                    'end':offset+len(line), 'url_start':offset+image.start(2), 'url_end':offset+image.end(2)})
            if not publication:
                publication = re.match(r'^\s*(?:[-*]\s*)?栏目\s*[:：]\s*([A-Za-z][A-Za-z0-9_-]{0,15})\s*/\s*(\d{1,4})\s*$', text)
        offset += len(line)
    if fence and code_language in ('python','python3','java'):
        raise ValueError('原稿存在未闭合的代码围栏，请在原稿中修复后重新导入')
    if len(images)>32 or len(codes)>20:
        raise ValueError('单篇补图最多支持32个图位、20段Python/Java示例')
    used = set()
    for image in images:
        match = re.match(r'图(\d+)[:：]', image['alt'])
        if match:
            no = int(match[1])
            if not 1 <= no <= 999 or no in used:
                raise ValueError('原稿的图号重复或超出1–999范围')
            image['figure_no'] = no;used.add(no)
    for image in images:
        if 'figure_no' not in image:
            no = next(number for number in range(1,1000) if number not in used)
            image['figure_no'] = no;used.add(no)
    return {'title':title,'images':images,'codes':codes,'anchors':anchors,
            'publication':{'series':publication[1],'episode':int(publication[2])} if publication else None}


def image_prompt(account: dict, title: str, caption: str, kind: str, series: str = '', episode: int = 0) -> str:
    from .accounts import profile_from_account
    from .image_prompts import assemble
    brand=profile_from_account(account)['brand']
    brand['visual_references']=account.get('visual_references',[])
    return assemble({'kind':kind,'caption':caption},title,series,episode,brand)


def create(engine: Any, store: Any, account: dict, file: Path, expected: str | None = None,
           *, on_created=None) -> dict:
    from .image_prompts import frozen_brand
    account=copy.deepcopy(account)
    account['visual_references']=frozen_brand(account,store,engine.cfg.runtime_root)['visual_references']
    file = normalize(file)
    if file.suffix.lower() != '.md' or not file.is_file() or file.stat().st_size > 400000:
        raise ValueError('请选择不超过400KB的Markdown文章')
    raw = file.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if expected and digest != expected:
        raise ValueError('原稿已变化，请刷新后重新导入')
    body = raw.decode('utf-8-sig')
    if not body.strip() or len(body)>100000:
        raise ValueError('文章不能为空或超过100000字符')
    parsed = parse_source(body)
    title = parsed['title'] or file.stem
    publication = parsed['publication'] or {'series':'UNSPECIFIED','episode':0}
    series, episode = publication['series'], publication['episode']  # Never advance the publication series.
    article_root = str(normalize(Path(account['article_root'])/'补图候选'))
    spec = {'image_only':True,'account_id':account['id'],'account_snapshot':copy.deepcopy(account),
            'article_root':article_root,'series':series,'episode':episode,'topic':title,
            'target_words':account['words_range'],'image_provider':'manual_import','approve_local_exec':False}
    job_id, article_id = engine.create_job(spec,limits={'max_model_calls':0,
        'max_image_model_calls':engine.cfg.profile.get('limits',{}).get('per_image_model_calls',12)},
        on_created=on_created)
    snapshot = engine.cfg.job_dir(job_id)/'original-source.md'
    snapshot.write_bytes(raw)
    store.register_artifact(new_id('artifact'),'source_snapshot',snapshot,digest)
    state = engine._load_state(job_id)
    state.update(integrated_md=body,draft_md=body,working_title=title,final_title=title,series=series,runs={})
    state['supplement'] = {'source':{'file_path':str(snapshot),'original_path':str(file),'sha256':digest,
        'body_hash':sha256_text(body)},'execution_requests':{}}
    store.conn.execute("UPDATE jobs SET workflow='supplement_images_v1',state='completed',current_node='assets' WHERE job_id=?",(job_id,))
    store.conn.commit()
    store.update_article(article_id,working_title=title,final_title=title,readiness='assets_pending')
    engine._save_state(job_id,state)
    store.add_revision({'revision_id':new_id('rev'),'article_id':article_id,'kind':'source_snapshot',
                        'content':body,'content_hash':sha256_text(body),'producer':'image-only-import'})
    for image in parsed['images']:
        reference = image['reference']
        kind = 'body_real' if any(word in reference+image['alt'] for word in ('截图','实截','运行输出','终端')) else 'cover' if '封面' in image['alt'] else 'body_ai'
        caption = re.sub(r'^图\d+[:：]','',image['alt']) or f'图{image["figure_no"]}'
        slot = {'slot_id':new_id('slot'),'article_id':article_id,'figure_no':image['figure_no'],
            'caption':caption,'kind':kind,'required':True,'position':'原稿图片位置','obtain':'真实运行截图或手动导入' if kind=='body_real' else 'TapNow手动生图或复用资源',
            'prompt':'' if kind=='body_real' else image_prompt(account,title,caption,kind,series,episode),'selected_candidate':None,
            'prompt_no':image['figure_no'] if kind!='body_real' else None,
            'source_image':image,'anchor_id':None}
        store.upsert_slot(slot)
        # Local article images become unselected candidates for human review.
        parsed_url = urlparse(reference)
        if not parsed_url.scheme and not parsed_url.netloc and not reference.startswith('待配图'):
            try:
                local = normalize(file.parent/unquote(parsed_url.path))
                assert_within(local,file.parent)
                if validate_image_file(local)[0]:
                    engine.import_asset(job_id,slot['figure_no'],local,accept=False)
            except (OSError,ValueError,PermissionError):
                pass  # Missing/escaping/remote images remain visible as pending slots.
    state = engine._load_state(job_id);state['slots']=store.article_slots(article_id)
    engine._save_state(job_id,state)
    store.append_event(job_id,'supplement.created',{'source_sha256':digest,'figures':len(parsed['images'])})
    return {'job_id':job_id,'article_id':article_id}


def checked(engine: Any, store: Any, job_id: str, account_id: str) -> tuple[dict,dict,dict]:
    job = store.get_job(job_id);article = store.get_article(job['article_id'])
    if not article['spec'].get('image_only') or article['spec'].get('account_id') != account_id:
        raise ValueError('只能操作当前公众号的补图任务')
    state = engine._load_state(job_id)
    verify_snapshot(engine.cfg,state,job_id)
    return job,article,state


def verify_snapshot(cfg: Any, state: dict, job_id: str) -> None:
    source = state['supplement']['source']
    snapshot = Path(source['file_path']);assert_within(snapshot,cfg.runtime_root/'jobs'/job_id)
    if not snapshot.is_file() or hashlib.sha256(snapshot.read_bytes()).hexdigest()!=source['sha256'] or sha256_text(state['integrated_md'])!=source['body_hash']:
        raise ValueError('原稿快照校验失败，不能继续补图')


def details(state: dict, slots: list[dict]) -> dict:
    body = state['integrated_md'];source = state['supplement']['source'];parsed = parse_source(body)
    original = Path(source['original_path'])
    try:
        status = 'unchanged' if original.is_file() and original.stat().st_size<=400000 and hashlib.sha256(original.read_bytes()).hexdigest()==source['sha256'] else 'changed_or_missing'
    except OSError:
        status = 'changed_or_missing'
    return {'source':source,'source_status':status,'anchors':parsed['anchors'],'codes':parsed['codes'],
            'plan_hash':sha256_json(slots),'preview_md':render_body(body,slots,{},preview=True)}


def save_plan(engine: Any, store: Any, job_id: str, account_id: str, params: dict) -> dict:
    job, article, state = checked(engine,store,job_id,account_id)
    if job['lease']:raise ValueError('任务正在运行，请稍后修改计划')
    old = store.article_slots(article['article_id'])
    if params.get('plan_hash') != sha256_json(old):raise ValueError('图位或已选图片已变化，请刷新计划')
    rows=params.get('slots')
    if not isinstance(rows,list) or len(rows)>32:raise ValueError('图位计划需为最多32项的列表')
    old_by_id={slot['slot_id']:slot for slot in old};anchors={anchor['id'] for anchor in parse_source(state['integrated_md'])['anchors']}
    updated=[];used_ids=set();used_nos=set()
    for row in rows:
        if not isinstance(row,dict):raise ValueError('图位信息无效')
        identifier=row.get('slot_id')
        if identifier and (identifier not in old_by_id or identifier in used_ids):raise ValueError('图位重复或不属于本文')
        slot=copy.deepcopy(old_by_id[identifier]) if identifier else {'slot_id':new_id('slot'),'article_id':article['article_id'],'selected_candidate':None,'source_image':None}
        if identifier:used_ids.add(identifier)
        no=row.get('figure_no')
        if not isinstance(no,int) or isinstance(no,bool) or not 1<=no<=999 or no in used_nos:raise ValueError('图号需为不重复的1–999整数')
        if identifier and no!=slot['figure_no']:raise ValueError('已有图位的图号不可更改')
        used_nos.add(no)
        caption=row.get('caption','');kind=row.get('kind');prompt=row.get('prompt','')
        if not isinstance(caption,str) or not caption.strip() or len(caption)>200 or any(c in caption for c in '\r\n[]'):
            raise ValueError('图注需为1–200字符，不能含换行或方括号')
        if kind not in ('cover','body_ai','body_real') or not isinstance(prompt,str) or len(prompt)>10000:raise ValueError('图位类型或提示词无效')
        anchor=None if slot.get('source_image') else row.get('anchor_id')
        if not slot.get('source_image') and anchor not in anchors:raise ValueError('请选择原稿中的插图位置')
        if any(slot.get(key)!=value for key,value in [('caption',caption),('kind',kind),('prompt',prompt),('anchor_id',anchor)]):
            slot['selected_candidate']=None
        slot.update(figure_no=no,caption=caption,kind=kind,prompt='' if kind=='body_real' else prompt,
                    prompt_no=no if kind!='body_real' else None,
                    anchor_id=anchor,required=True,position='原稿图片位置' if slot.get('source_image') else anchor,
                    obtain='Agent真实运行截图/手动导入' if kind=='body_real' else '手动TapNow生图/资源复用')
        updated.append(slot)
    if used_ids!=set(old_by_id):raise ValueError('旧图位须保留；可否决图片，但不能删除原稿图片位置')
    with store.transaction():
        if store.get_job(job_id)['lease'] or sha256_json(store.article_slots(article['article_id']))!=params.get('plan_hash'):
            raise ValueError('图位或任务状态已变化，请刷新')
        for slot in updated:
            store.conn.execute('INSERT INTO asset_slots VALUES (?,?,?,?,?) ON CONFLICT(slot_id) DO UPDATE SET slot_json=excluded.slot_json,figure_no=excluded.figure_no',
                (slot['slot_id'],article['article_id'],slot['figure_no'],None,json.dumps(slot,ensure_ascii=False)))
        state['slots']=updated;state.pop('final_check_report',None)
        store.save_checkpoint(job_id,state,commit=False)
        store.conn.execute("UPDATE articles SET readiness='assets_pending' WHERE article_id=?",(article['article_id'],))
    engine._write_state_file(job_id,state)
    store.append_event(job_id,'supplement.plan_saved',{'plan_hash':sha256_json(updated)})
    return {'plan_hash':sha256_json(updated)}


def render_body(body: str, slots: list[dict], figures: dict[int,str], *, preview: bool=False) -> str:
    anchors={anchor['id']:anchor['offset'] for anchor in parse_source(body)['anchors']};changes=[]
    newline='\r\n' if '\r\n' in body else '\n'
    for slot in slots:
        reference=figures.get(slot['figure_no'])
        image=slot.get('source_image')
        if image:
            if preview:
                markup=f'![图{slot["figure_no"]}：{slot["caption"]}]({reference or "待配图：图片"})'+newline
                changes.append((image['start'],image['end'],markup,slot['figure_no']))
            elif reference:
                changes.append((image['url_start'],image['url_end'],reference,slot['figure_no']))
        else:
            offset=anchors[slot['anchor_id']]
            markup=f'{newline}![图{slot["figure_no"]}：{slot["caption"]}]({reference or "待配图："+slot["kind"]}){newline}{newline}'
            changes.append((offset,offset,markup,slot['figure_no']))
    for start,end,text,no in sorted(changes,key=lambda change:(change[0],change[3]),reverse=True):
        body=body[:start]+text+body[end:]
    return body


def export_notes(state: dict, slots: list[dict], figures: dict[int,str]) -> dict[str,str]:
    source=state['supplement']['source']
    entry=(f'# 补图候选阅读入口：{state["final_title"]}\n\n'
        f'- 原稿：{source["original_path"]}（只读）\n- 原文件 SHA256：{source["sha256"]}\n'
        f'- 原稿正文 SHA256：{source["body_hash"]}\n- 导出时间：{now_iso()}\n\n'
        '本任务只补图。标题、期号、正文文字和代码不由 AI 改写；仅替换图片地址或在确认位置插入图片。\n'
        '补图齐全不代表文章事实、代码描述或发布审核通过；请对照原稿自行检查。\n\n'
        f'已选用有效图片：{len(figures)} / {len(slots)}。真实执行记录：{len(state.get("runs",{}))} 条。\n'
        '补图候选保存在独立输出目录，原文件没有写回。04 文件可离线阅读，05 文件记录图片变更。\n')
    publish='# 补图方案与人工核对\n\n| 图号 | 内容 | 类型 | 选用图片 |\n|---|---|---|---|\n'
    for slot in slots:
        publish+=f'| 图{slot["figure_no"]} | {slot["caption"].replace("|","/")} | {slot["kind"]} | {figures.get(slot["figure_no"],"待准备")} |\n'
    publish+='\n- [ ] 对照原稿检查标题、期号、文字和代码\n- [ ] 逐张审核图片与文章位置是否相符\n- [ ] 核对引用来源、事实、代码描述和发布当天信息\n- [ ] 在公众号后台完成排版和手机预览\n'
    changes={'workflow':'supplement_images_v1','source_sha256':source['sha256'],'body_sha256':source['body_hash'],
        'text_rewritten':False,'publication_review_passed':False,
        'figures':[{'figure_no':slot['figure_no'],'original_reference':(slot.get('source_image') or {}).get('reference'),
            'anchor_id':slot.get('anchor_id'),'export_reference':figures.get(slot['figure_no']),
            'selected_candidate':slot.get('selected_candidate')} for slot in slots]}
    return {'00-阅读入口.md':entry,'02-发布信息与排版说明.md':publish,
            '05-补图变更记录.json':json.dumps(changes,ensure_ascii=False,indent=2)}


def prepare_execution(engine: Any, store: Any, job_id: str, account_id: str, params: dict) -> dict:
    job,article,state=checked(engine,store,job_id,account_id)
    if job['lease']:raise ValueError('任务正在执行')
    codes=parse_source(state['integrated_md'])['codes'];index=params.get('code_index')
    if not isinstance(index,int) or isinstance(index,bool) or not 0<=index<len(codes):raise ValueError('请选本文中的Python/Java代码')
    stdin=params.get('stdin','')
    if not isinstance(stdin,str) or len(stdin)>4000:raise ValueError('示例输入最多4000字符')
    from .execution.plan import input_calls
    if input_calls(codes[index]['source'],codes[index]['language']) and not stdin:
        raise ValueError('这段代码需要示例输入，请按程序读取顺序每行填写一项后再预览')
    expected=params.get('expect_failure',False)
    if not isinstance(expected,bool):raise ValueError('预期报错需为布尔值')
    request={**codes[index],'stdin':stdin,'expect_failure':expected,'body_hash':state['supplement']['source']['body_hash']}
    request['content_hash']=sha256_json(request)
    with store.transaction():
        if store.get_job(job_id)['lease']:raise ValueError('任务正在执行，请稍后重新预览')
        state=engine._load_state(job_id)
        state['supplement']['execution_requests'][str(index)]=request
        store.save_checkpoint(job_id,state,commit=False)
    engine._write_state_file(job_id,state)
    return request


def execute(engine: Any, store: Any, job_id: str, account_id: str, params: dict) -> dict:
    job,article,state=checked(engine,store,job_id,account_id)
    index=params.get('code_index');request=state['supplement']['execution_requests'].get(str(index))
    if not request or params.get('content_hash')!=request['content_hash'] or params.get('reviewed') is not True:
        raise ValueError('请先审阅当前源码与输入，再明确允许本次本机执行')
    codes=parse_source(state['integrated_md'])['codes']
    if not isinstance(index,int) or isinstance(index,bool) or not 0<=index<len(codes) or codes[index]['source']!=request['source'] or request['body_hash']!=state['supplement']['source']['body_hash'] or sha256_json({key:value for key,value in request.items() if key!='content_hash'})!=request['content_hash']:
        raise ValueError('执行候选与当前原稿不一致，请重新审阅')
    key=f'supplement-{index+1}'
    previous=state.get('runs',{}).get(key)
    if previous and previous.get('execution_hash')==request['content_hash'] and previous.get('verdict') in ('ok','expected_failure_ok'):
        return {'run_key':key,'run':previous,'reused':True}
    lease=new_id('lease')
    if not store.claim_job(job_id,lease):raise ValueError('本篇已有任务正在执行')
    try:
        state=engine._load_state(job_id)
        current=state['supplement']['execution_requests'].get(str(index))
        if not current or current['content_hash']!=request['content_hash']:
            raise ValueError('源码与输入候选已变化，请重新审阅')
        # Normalize the last line too: Python and Scanner always receive complete lines.
        events=[line+'\n' for line in request['stdin'].splitlines()]
        run_spec=RunSpec(language=request['language'],source=request['source'],filename=request['filename'],
                         stdin_events=events,timeout_s=20.0,expect_failure=request.get('expect_failure',False))
        record=(engine.runner.run_java(run_spec,reviewed=True) if request['language']=='java' else engine.runner.run_python(run_spec,reviewed=True))
        from .execution.runner import verdict
        run={**record.to_dict(),'source':request['source'],'filename':request['filename'],'source_index':index,
             'source_body_hash':request['body_hash'],'execution_hash':request['content_hash'],
             'expected_failure':run_spec.expect_failure,'verdict':verdict(record,run_spec)}
        # Keep all attempts in the event journal; the slot can use the newest run.
        state.setdefault('runs',{})[key]=run
        engine._save_state(job_id,state)
        store.append_event(job_id,'supplement.executed',{'run_key':key,'run':run})
        return {'run_key':key,'run':run,'reused':False}
    finally:store.release_job(job_id,lease)


def finalize(engine: Any, store: Any, job_id: str, account_id: str) -> dict:
    job,article,state=checked(engine,store,job_id,account_id)
    if job['lease']:raise ValueError('请等待执行结束再导出')
    lease=new_id('lease')
    if not store.claim_job(job_id,lease):raise ValueError('本篇已有任务正在执行')
    try:return _finalize_claimed(engine,store,job_id,account_id)
    finally:store.release_job(job_id,lease)


def _finalize_claimed(engine: Any, store: Any, job_id: str, account_id: str) -> dict:
    job,article,state=checked(engine,store,job_id,account_id)
    slots=store.article_slots(article['article_id'])
    ready=bool(slots) and all(selected_asset(store,slot) for slot in slots)
    state['slots']=slots
    state['final_check_report']={'ready':False,'assets_ready':ready,'assets_accepted':sum(bool(selected_asset(store,slot)) for slot in slots),
        'assets_required':len(slots),'rules':{'passed':False,'report':{'blocking':[]}},
        'note':'只检查补图完整性；正文事实、代码描述和发布审核未自动通过。'}
    readiness='images_ready' if ready else 'assets_pending'
    store.update_article(article['article_id'],readiness=readiness)
    article=store.get_article(article['article_id'])
    engine.exporter.article_root=Path(article['spec']['article_root'])
    result=engine.exporter(engine._make_ctx(job,article,state))
    state['export_result']=result;engine._save_state(job_id,state)
    store.append_event(job_id,'supplement.exported',{'readiness':readiness,'folder':result['folder']})
    return {'readiness':readiness,'export':result,'assets_ready':ready}
