import * as React from 'react';
import { Banner,Button,Dialog,ErrorPanel,Spinner } from '../../components/ui';
import { toast } from '../../components/toast';
import { dirtyStore,queryClient,registerDirtyFlush,rpc,useAccountQuery,useCurrentAccount } from '../../data/client';
import { openEditor } from '../../data/actions';
import { ApprovalReview } from './ApprovalReview';
import { ExecutionReview,RunResults } from './ExecutionReview';
import { NODE_LABEL } from './taskTypes';
import { jobGuide } from './jobGuide';
import type { Approval,TaskDetail } from './taskTypes';
import type { decisionParams } from './reviewModel';
import '../../styles/task-review.css';

export function WorkflowReview({jobId,onClose}:{jobId:string;onClose:()=>void}) {
  const account=useCurrentAccount();
  const dirtyKey=`task-review:${account}:${jobId}`;
  const [snapshot,setSnapshot]=React.useState<TaskDetail|null>(null);
  const [dirty,setDirty]=React.useState(false);
  const dirtyRef=React.useRef(false);
  const [busy,setBusy]=React.useState(false);
  const busyRef=React.useRef(false);
  const [advance,setAdvance]=React.useState<string|null>(null);
  const [error,setError]=React.useState<string|null>(null);
  const [conflict,setConflict]=React.useState(false);
  const [closePrompt,setClosePrompt]=React.useState(false);
  const polling=Boolean(advance||snapshot?.job.lease||['queued','running'].includes(snapshot?.job.state??''));
  const query=useAccountQuery<TaskDetail>('jobs.get',{job_id:jobId},{staleTime:0,refetchOnMount:'always',refetchInterval:polling?1000:false});
  const markDirty=React.useCallback((value:boolean)=>{
    dirtyRef.current=value;setDirty(value);
    if(value)dirtyStore.markDirty(dirtyKey);else dirtyStore.markClean(dirtyKey);
  },[dirtyKey]);
  React.useEffect(()=>{
    const unregister=registerDirtyFlush(dirtyKey,()=>{
      if(dirtyRef.current)throw Error('审阅方案有未保存修改，请先保存或放弃修改再切换。');
    });
    return()=>{unregister();dirtyStore.markClean(dirtyKey);};
  },[dirtyKey]);
  React.useEffect(()=>{
    if(!query.data||query.isFetching)return;
    if(query.data.article.spec.account_id!==account)return;
    if(dirtyRef.current){
      if(snapshot?.pending_approval?.content_hash!==query.data.pending_approval?.content_hash||
         snapshot?.execution_hash!==query.data.execution_hash||snapshot?.job.state!==query.data.job.state)setConflict(true);
      return;
    }
    setSnapshot(query.data);
    if(advance&&(query.data.pending_approval?.content_hash!==advance&&query.data.pending_approval||
       ['completed','failed','cancelled','paused','awaiting_user'].includes(query.data.job.state)))setAdvance(null);
    // Only install server responses. A local save updates snapshot first; its
    // older cached query must not overwrite the newly acknowledged hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[query.data,query.isFetching,account]);
  const refreshJobs=()=>queryClient.invalidateQueries({queryKey:['ice',account,'jobs.list']});
  const perform=async(action:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);setError(null);
    try{await action();}
    catch(problem){setError((problem as Error).message);setAdvance(null);}
    finally{busyRef.current=false;setBusy(false);}
  };
  const savePayload=async(draft:Approval)=>{
    const original=snapshot?.pending_approval;
    if(!original||original.approval_id!==draft.approval_id||original.content_hash!==draft.content_hash)throw Error('候选已变化，请刷新后审阅。');
    if(JSON.stringify(original.payload)===JSON.stringify(draft.payload))return draft;
    const result=await rpc<{content_hash:string}>('approvals.edit',{
      job_id:jobId,approval_id:draft.approval_id,content_hash:draft.content_hash,payload:draft.payload,
    });
    const saved={...draft,content_hash:result.content_hash};
    setSnapshot(previous=>previous&&({...previous,pending_approval:saved}));
    markDirty(false);
    return saved;
  };
  const save=(draft:Approval)=>perform(async()=>{
    await savePayload(draft);setConflict(false);
    toast.success({title:'方案修改已保存',detail:'任务仍停留在当前步骤，确认后才继续。'});
  });
  const decide=(draft:Approval,params:ReturnType<typeof decisionParams>)=>perform(async()=>{
    const current=params.decision==='approve'?await savePayload(draft):draft;
    await rpc('approvals.decide',{...params,content_hash:current.content_hash});
    markDirty(false);setClosePrompt(false);setConflict(false);setAdvance(current.content_hash);
    await refreshJobs();await query.refetch();
  });
  const run=(params:Record<string,unknown>)=>perform(async()=>{
    await rpc('execution.approve',params);
    markDirty(false);setConflict(false);setAdvance('execution');
    await refreshJobs();await query.refetch();
  });
  const resume=()=>perform(async()=>{
    await rpc('jobs.resume',{job_id:jobId});setAdvance('resume');
    await refreshJobs();await query.refetch();
  });
  const stop=()=>perform(async()=>{
    await rpc('jobs.stop',{job_id:jobId});setAdvance('stopping');
    await refreshJobs();await query.refetch();
  });
  const requestClose=()=>{
    if(busyRef.current)return;
    if(dirtyRef.current)setClosePrompt(true);else onClose();
  };
  const refresh=()=>{
    if(dirtyRef.current){setClosePrompt(true);return;}
    setError(null);setConflict(false);void query.refetch();
  };
  const locked=busy||conflict||Boolean(advance)||Boolean(snapshot?.job.lease);
  const guide=snapshot?jobGuide(snapshot.job):null;
  const approval=snapshot?.pending_approval;
  const hasExecution=snapshot?.job.current_node==='verify_code'&&snapshot.execution;
  return <Dialog open onOpenChange={open=>{if(!open)requestClose();}} width={860}
    title="文章制作与审阅" description="查看当前步骤，修改并确认方案，或审阅代码与示例输入。每次决定都对应当前内容版本。"
    footer={<>
      {closePrompt?<>
        <span className="ice-task-review__hint" role="status">有修改尚未保存。</span>
        <Button onClick={()=>setClosePrompt(false)}>继续编辑</Button>
        <Button variant="danger" onClick={()=>{markDirty(false);onClose();}}>放弃修改并关闭</Button>
      </>:<>
        <span className="ice-task-review__hint" style={{flex:1}} role="status">{busy?'正在提交…':dirty?'修改尚未保存':advance?'请求已提交，正在读取后续步骤…':''}</span>
        {snapshot&&!snapshot.pending_approval&&['running','queued'].includes(snapshot.job.state)&&
          <Button variant="danger" disabled={busy||dirty} onClick={()=>void stop()}>暂停制作</Button>}
        <Button variant="ghost" disabled={busy||dirty} onClick={refresh}>刷新状态</Button>
        <Button disabled={busy} onClick={requestClose}>关闭</Button>
      </>}
    </>}>
    {!snapshot&&query.isError&&<ErrorPanel title="任务读取失败" detail={query.error.message} onRetry={refresh} />}
    {!snapshot&&!query.isError&&<div className="ice-task-review__status"><Spinner />正在读取任务…</div>}
    {snapshot&&<div className="ice-task-review">
      <header className="ice-task-review__heading"><strong>{snapshot.article.final_title||snapshot.article.topic}</strong>
        <span className="ice-badge">{snapshot.article.series}/{String(snapshot.article.episode).padStart(3,'0')}</span>
        {snapshot.article.spec.demo&&<span className="ice-badge">离线演示</span>}
      </header>
      <div className="ice-task-review__status" role="status">
        {(polling||busy)&&<Spinner size={14} />}当前步骤：{NODE_LABEL[snapshot.job.current_node]??snapshot.job.current_node}
        {snapshot.job.state==='completed'?' · 制作完成':snapshot.job.state==='failed'?' · 已中断':snapshot.job.state==='paused'?(snapshot.job.lease?' · 正在停止当前程序…':' · 已暂停'):snapshot.job.state==='cancelled'?' · 已取消':advance?' · 正在继续':''}
      </div>
      {/* 批A2：确定性的建议下一步（与任务卡同一纯推导；不自动执行任何动作）。 */}
      <p className="ice-task-review__hint">建议下一步：{guide?.actions[0]?.label} — {guide?.actions[0]?.hint}</p>
      {error&&<Banner tone="danger" title="操作未完成">{error}。当前修改已保留，请核对状态后再试。</Banner>}
      {query.error&&<Banner tone="warning" title="暂未读取到最新状态">{query.error.message}</Banner>}
      {conflict&&<Banner tone="warning" title="任务内容已在别处变化">当前修改仍保留。可复制方案后关闭并放弃修改，再重新打开合并。</Banner>}
      {approval?<>
        <ApprovalReview key={approval.approval_id} approval={approval} jobId={jobId}
          disabled={locked} onDirty={markDirty} onSave={save} onDecide={decide} />
        <RunResults detail={snapshot} />
      </>:hasExecution?<ExecutionReview key={snapshot.execution_hash??'execution'} detail={snapshot} disabled={locked}
          onDirty={markDirty} onRun={run} onResume={resume} />:<>
        {snapshot.job.pause_reason&&<Banner tone={snapshot.job.state==='failed'?'danger':'info'} title="任务说明">{snapshot.job.pause_reason}</Banner>}
        {snapshot.job.state==='completed'&&<Button variant="primary" onClick={()=>void perform(async()=>{await openEditor(jobId);onClose();})}>打开正文编辑与交付审阅</Button>}
        {snapshot.job.state==='paused'&&<Button variant="primary" disabled={busy||Boolean(snapshot.job.lease)} onClick={()=>void resume()}>继续制作</Button>}
        {['queued','running'].includes(snapshot.job.state)&&<p className="ice-task-review__hint">完成当前处理后，会在这里显示下一步需要审阅的内容。</p>}
        <RunResults detail={snapshot} />
      </>}
    </div>}
  </Dialog>;
}
