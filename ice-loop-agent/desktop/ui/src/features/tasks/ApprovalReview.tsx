import * as React from 'react';
import { Button, Input } from '../../components/ui';
import { CopyButton } from '../../components/CopyButton';
import type { Approval } from './taskTypes';
import { REVIEW_LABEL } from './taskTypes';
import { asRows, changeReviewRow, decisionParams, recommendedChoice, reviewError, reviewRows, textValue } from './reviewModel';

export function ApprovalReview({ approval,jobId,disabled,onDirty,onSave,onDecide }: {
  approval:Approval;jobId:string;disabled:boolean;onDirty:(dirty:boolean)=>void;
  onSave:(approval:Approval)=>Promise<void>;
  onDecide:(approval:Approval,params:ReturnType<typeof decisionParams>)=>Promise<void>;
}) {
  const [draft,setDraft]=React.useState(approval);
  const [choice,setChoice]=React.useState(()=>recommendedChoice(approval));
  const [rejecting,setRejecting]=React.useState(false);
  const [note,setNote]=React.useState('');
  const dirty=JSON.stringify(draft.payload)!==JSON.stringify(approval.payload);
  const error=reviewError(draft),rows=reviewRows(draft);
  const editable=approval.scope!=='asset_plan';
  React.useEffect(()=>{
    setDraft(approval);
    setChoice(previous=>previous<reviewRows(approval).length?previous:recommendedChoice(approval));
  },[approval]);
  React.useEffect(()=>()=>onDirty(false),[onDirty]);
  const update=(next:Approval)=>{setDraft(next);onDirty(JSON.stringify(next.payload)!==JSON.stringify(approval.payload));};
  const field=(index:number,name:string,value:string)=>update(changeReviewRow(draft,index,name,value));
  const selectedText=rows.map((row,index)=>`${index+1}. ${textValue(row['标题候选'])||textValue(row.title)||textValue(row.h2)||textValue(row.caption)}\n${textValue(row['核心角度'])||textValue(row.goal)||textValue(row.summary)}`).join('\n\n');
  const decide=(decision:'approve'|'reject')=>onDecide(draft,decisionParams(jobId,draft,choice,decision,note));
  return <section className="ice-task-review" aria-label={REVIEW_LABEL[approval.scope]??'审阅方案'}>
    <div className="ice-task-review__heading">
      <h3>{REVIEW_LABEL[approval.scope]??'审阅方案'}</h3>
      <CopyButton label="复制当前方案" text={[textValue(draft.payload.working_title),selectedText].filter(Boolean).join('\n\n')} />
    </div>
    <p className="ice-task-review__hint">确认后会沿用这份方案继续制作；可以先修改内容，再保存或确认。</p>
    {['topic','outline'].includes(approval.scope)&&<label className="ice-task-review__field">工作标题
      <Input aria-label="工作标题" value={textValue(draft.payload.working_title)} disabled={disabled}
        onChange={event=>update({...draft,payload:{...draft.payload,working_title:event.target.value}})} />
    </label>}
    {approval.scope==='topic'&&rows.map((row,index)=><fieldset key={index} disabled={disabled} className="ice-task-review__card" data-selected={choice===index}>
      <legend>选题 {index+1}</legend>
      <label className="ice-task-review__choice"><input type="radio" name="review-topic" value={index} checked={choice===index} onChange={()=>setChoice(index)} />
        选用这个方向{index===recommendedChoice(approval)&&<span className="ice-badge">AI 推荐</span>}</label>
      <label className="ice-task-review__field">标题<Input aria-label={`选题 ${index+1} 标题`} value={textValue(row['标题候选'])} onChange={event=>field(index,'标题候选',event.target.value)} /></label>
      <label className="ice-task-review__field">核心角度<textarea aria-label={`选题 ${index+1} 核心角度`} rows={2} value={textValue(row['核心角度'])} onChange={event=>field(index,'核心角度',event.target.value)} /></label>
      <p className="ice-task-review__hint">{textValue(row['文章类型'])}{textValue(row['证据要求'])&&` · ${textValue(row['证据要求'])}`}</p>
    </fieldset>)}
    {approval.scope==='outline'&&<>
      {textValue((draft.payload.opening as Record<string,unknown>|undefined)?.way)&&<p className="ice-task-review__hint">开篇方式：{textValue((draft.payload.opening as Record<string,unknown>).way)}</p>}
      {rows.map((row,index)=><fieldset key={index} disabled={disabled} className="ice-task-review__card"><legend>章节 {index+1}</legend>
        <label className="ice-task-review__field">章节标题<Input aria-label={`章节 ${index+1} 标题`} value={textValue(row.h2)} onChange={event=>field(index,'h2',event.target.value)} /></label>
        {(typeof row.goal==='string'||typeof row.summary==='string')&&<label className="ice-task-review__field">本节要解决的问题
          <textarea rows={2} value={textValue(row.goal)||textValue(row.summary)} onChange={event=>field(index,typeof row.goal==='string'?'goal':'summary',event.target.value)} /></label>}
        {asRows(row.h3s).map((sub,subIndex)=><div key={subIndex} className="ice-task-review__outline-part"><strong>{textValue(sub.h3)}</strong>
          {Array.isArray(sub.points)&&<ul>{sub.points.filter((point):point is string=>typeof point==='string').map((point,i)=><li key={i}>{point}</li>)}</ul>}</div>)}
        {Array.isArray(row.code)&&row.code.length>0&&<p className="ice-task-review__hint">演示程序：{row.code.filter((value):value is string=>typeof value==='string').join('、')}</p>}
        {asRows(row.figures).map((figure,i)=><p key={i} className="ice-task-review__hint">配图：{textValue(figure.caption)} · {textValue(figure.obtain)}</p>)}
      </fieldset>)}
    </>}
    {approval.scope==='final_title'&&<>
      <p className="ice-task-review__hint">{textValue(draft.payload.recommend_reason)}</p>
      {rows.map((row,index)=><fieldset key={index} disabled={disabled} className="ice-task-review__card" data-selected={choice===index}><legend>标题 {index+1}</legend>
        <label className="ice-task-review__choice"><input type="radio" name="review-title" checked={choice===index} onChange={()=>setChoice(index)} />选用这个标题</label>
        <Input aria-label={`标题 ${index+1}`} value={textValue(row.title)} onChange={event=>field(index,'title',event.target.value)} />
        <p className="ice-task-review__hint">{textValue(row.mechanism)}{typeof row.total==='number'?` · 原候选参考评分 ${row.total}/25`:''}</p>
      </fieldset>)}
    </>}
    {approval.scope==='asset_plan'&&<>
      {!rows.length&&<p>本期方案没有安排配图。</p>}
      {rows.map((row,index)=><div key={index} className="ice-task-review__card"><h4>图 {String(row.figure_no??index+1)} · {textValue(row.caption)}</h4>
        <p>位置：{textValue(row.position)}</p><p>获取方式：{textValue(row.obtain)}</p>
        {typeof row.required==='boolean'&&<span className="ice-badge">{row.required?'必需配图':'可选配图'}</span>}
      </div>)}
      <p className="ice-task-review__hint">这一步确认配图用途。生成图由你在 TapNow 制作，随后导入相应图位。</p>
    </>}
    {error&&<p className="ice-error-text" role="alert">{error}</p>}
    {rejecting?<div className="ice-task-review__card">
      <label className="ice-task-review__field">否决原因（可选）<textarea aria-label="否决原因" rows={2} maxLength={1000} value={note} disabled={disabled} onChange={event=>setNote(event.target.value)} /></label>
      <div className="ice-task-review__actions"><Button variant="danger" disabled={disabled} onClick={()=>void decide('reject')}>否决并停止</Button><Button variant="ghost" disabled={disabled} onClick={()=>setRejecting(false)}>返回审阅</Button></div>
    </div>:<div className="ice-task-review__actions">
      <Button variant="primary" disabled={disabled||Boolean(error)} onClick={()=>void decide('approve')}>{dirty?'保存修改并继续':'确认并继续'}</Button>
      {editable&&<Button disabled={disabled||!dirty||Boolean(error)} onClick={()=>void onSave(draft)}>仅保存修改</Button>}
      <Button variant="ghost" disabled={disabled} onClick={()=>setRejecting(true)}>否决此步</Button>
    </div>}
  </section>;
}
