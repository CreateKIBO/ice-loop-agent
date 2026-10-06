"""Account-scoped, version-bound accept/reject decisions for single candidates."""
import hashlib
import json
from typing import Any
from pathlib import Path

from .domain.types import now_iso, sha256_json
from .providers.tapnow import validate_image_file


def review(engine: Any, store: Any, account_id: str, params: dict) -> dict:
    job_id=params['job_id'];job=store.get_job(job_id);article=store.get_article(job['article_id'])
    if article['spec'].get('account_id','ice-loop')!=account_id:raise ValueError('只能审核当前公众号的配图')
    status=params.get('decision');note=params.get('note','')
    if status not in ('accepted','rejected') or not isinstance(note,str) or len(note)>1000:
        raise ValueError('请填写有效的配图审核决定')
    if status=='rejected' and not note.strip():raise ValueError('否决图片时请填写原因')
    with store.transaction():
        if store.get_job(job_id)['lease']:raise ValueError('任务正在运行，请稍后审核')
        approval=store.pending_approval(job_id)
        if approval and approval['scope']=='asset_plan':raise ValueError('请先确认配图计划')
        slots=store.article_slots(article['article_id'])
        slot=next((slot for slot in slots if any(row['candidate_id']==params.get('candidate_id') for row in store.slot_candidates(slot['slot_id']))),None)
        if not slot or params.get('slot_hash')!=sha256_json(slot):raise ValueError('图位已变化或图片不属于本文，请刷新')
        candidate=next(row for row in store.slot_candidates(slot['slot_id']) if row['candidate_id']==params['candidate_id'])
        if params.get('content_hash')!=candidate['content_hash']:raise ValueError('图片审核记录已变化，请刷新')
        if status=='accepted':
            file=Path(candidate['file_path'])
            if not validate_image_file(file)[0] or hashlib.sha256(file.read_bytes()).hexdigest()!=candidate['sha256']:
                raise ValueError('图片已损坏或缺失，不能接受')
            slot['selected_candidate']=candidate['candidate_id']
        elif slot.get('selected_candidate')==candidate['candidate_id']:
            slot['selected_candidate']=None
        store.conn.execute('UPDATE asset_candidates SET review_status=? WHERE candidate_id=?',(status,candidate['candidate_id']))
        store.conn.execute('INSERT INTO asset_reviews VALUES (?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=excluded.updated_at',
                           (candidate['candidate_id'],status,note.strip(),now_iso()))
        store.conn.execute('UPDATE asset_slots SET slot_json=? WHERE slot_id=?',(json.dumps(slot,ensure_ascii=False),slot['slot_id']))
        state=engine._load_state(job_id);state['slots']=[slot if row['slot_id']==slot['slot_id'] else row for row in slots]
        state.pop('final_check_report',None)
        store.save_checkpoint(job_id,state,commit=False)
        store.conn.execute("UPDATE articles SET readiness='assets_pending' WHERE article_id=?",(article['article_id'],))
    engine._write_state_file(job_id,state)
    store.append_event(job_id,'asset.reviewed',{'candidate_id':candidate['candidate_id'],'decision':status,'note':note.strip(),'image_sha256':candidate['sha256']})
    return {'ok':True,'selected_candidate':slot.get('selected_candidate')}
