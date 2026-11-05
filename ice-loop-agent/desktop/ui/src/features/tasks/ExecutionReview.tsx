import * as React from 'react';
import { Button } from '../../components/ui';
import { CopyButton } from '../../components/CopyButton';
import type { TaskDetail } from './taskTypes';
import { executionExpectations, executionInputs, missingInputNames } from './reviewModel';

export function ExecutionReview({detail,disabled,onDirty,onRun,onResume}: {
  detail:TaskDetail;disabled:boolean;onDirty:(dirty:boolean)=>void;
  onRun:(params:Record<string,unknown>)=>Promise<void>;onResume:()=>Promise<void>;
}) {
  const plan=detail.execution!;
  const [inputs,setInputs]=React.useState(()=>executionInputs(plan.blocks));
  const [expectations,setExpectations]=React.useState(()=>executionExpectations(plan.blocks));
  const [reviewed,setReviewed]=React.useState(false);
  const initial=JSON.stringify({inputs:executionInputs(plan.blocks),expectations:executionExpectations(plan.blocks)});
  const dirty=JSON.stringify({inputs,expectations})!==initial;
  const missing=missingInputNames(plan.blocks,inputs);
  const alreadyApproved=plan.approved&&!dirty&&!missing.length;
  const ready=['awaiting_user','paused','failed'].includes(detail.job.state)&&!detail.job.lease;
  React.useEffect(()=>()=>onDirty(false),[onDirty]);
  const changeInput=(name:string,value:string)=>{
    const next={...inputs,[name]:value};setInputs(next);setReviewed(false);
    onDirty(JSON.stringify({inputs:next,expectations})!==initial);
  };
  const changeExpectation=(name:string,value:boolean)=>{
    const next={...expectations,[name]:value};setExpectations(next);setReviewed(false);
    onDirty(JSON.stringify({inputs,expectations:next})!==initial);
  };
  if(detail.execution_retired)return <section className="ice-task-review" aria-label="代码执行已退场">
    <p>代码执行与终端截图已在 v3 退场。历史记录只读保留；如需继续写作，请复制为新文章。</p>
    <RunResults detail={detail}/>
  </section>;
  return <section className="ice-task-review" aria-label="审阅代码与示例输入">
    <div className="ice-task-review__heading"><h3>审阅代码与示例输入</h3><span className="ice-badge">{plan.mode==='docker'?'隔离容器':'本机执行'}</span></div>
    <p className="ice-task-review__hint">请检查实际源码与输入。每行对应一次输入；执行输出会作为文章的真实运行证据。</p>
    {plan.blocks.map(block=><fieldset key={block.stdin_key} disabled={disabled||!ready} className="ice-task-review__card">
      <legend>{block.index}. {block.filename}</legend>
      <div className="ice-task-review__heading"><span className="ice-badge">{block.language}</span><CopyButton label={`复制 ${block.filename} 源码`} text={block.source} /></div>
      <pre className="ice-task-review__code"><code>{block.source}</code></pre>
      <label className="ice-task-review__field">示例输入{block.input_calls>0?'（需要输入）':'（可选）'}
        <textarea aria-label={`${block.stdin_key} 示例输入`} rows={Math.min(6,Math.max(2,block.input_calls+1))} maxLength={4000}
          value={inputs[block.stdin_key]??''} onChange={event=>changeInput(block.stdin_key,event.target.value)}
          placeholder={block.input_calls>0?'在这里填写程序所需的输入，每行一次':''} />
      </label>
      {block.input_calls>0&&<p className="ice-task-review__hint">检测到 {block.input_calls} 处输入读取；如果代码循环读取，请提供足够的输入行。</p>}
      <label className="ice-task-review__choice"><input type="checkbox" checked={expectations[String(block.index)]??false} onChange={event=>changeExpectation(String(block.index),event.target.checked)} />此片段用于展示预期报错</label>
    </fieldset>)}
    {!plan.blocks.length&&<p>当前正文没有可执行代码。</p>}
    {missing.length>0&&<p className="ice-error-text" role="status">还需填写：{missing.join('、')}</p>}
    {alreadyApproved?<p className="ice-task-review__hint">当前代码和输入版本已有批准，可以直接继续。</p>:
      <label className="ice-task-review__choice"><input type="checkbox" checked={reviewed} disabled={disabled||!ready} onChange={event=>setReviewed(event.target.checked)} />我已审阅以上源码、输入和预期结果，确认运行</label>}
    <div className="ice-task-review__actions">
      <Button variant="primary" disabled={disabled||!ready||Boolean(missing.length)||(!alreadyApproved&&!reviewed)}
        onClick={()=>{
          setReviewed(false);
          if(alreadyApproved) void onResume();
          else void onRun({job_id:detail.job.job_id,content_hash:plan.content_hash,stdin_by_filename:inputs,expected_failures:expectations});
        }}>{alreadyApproved?'继续已批准的任务':'确认运行并继续'}</Button>
    </div>
    <RunResults detail={detail} />
  </section>;
}

export function RunResults({detail}:{detail:TaskDetail}) {
  const runs=Object.values(detail.runs??{});
  if(!runs.length)return null;
  return <section className="ice-task-review" aria-label="实际运行记录"><h3>实际运行记录</h3>
    {runs.map(run=><details key={run.run_id} className="ice-task-review__card"><summary>{run.filename} · {({ok:'运行通过',expected_failure_ok:'符合预期报错',cancelled:'已停止运行',runtime_error:'运行报错',timed_out:'运行超时',output_limit_exceeded:'输出超出限制',expected_failure_but_succeeded:'预期报错但运行成功'} as Record<string,string>)[run.verdict]??run.verdict} · exit {run.exit_code}</summary>
      <p className="ice-task-review__hint">耗时 {run.duration_ms} ms</p>
      <pre className="ice-task-review__code">{run.stdout||'（无标准输出）'}{run.stderr&&'\n[stderr]\n'+run.stderr}</pre>
      <CopyButton label={`复制 ${run.filename} 输出`} text={run.stdout+(run.stderr?'\n[stderr]\n'+run.stderr:'')} />
    </details>)}
  </section>;
}
