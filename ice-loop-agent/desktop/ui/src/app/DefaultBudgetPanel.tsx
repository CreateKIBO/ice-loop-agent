import * as React from 'react';
import { Banner,Button,Input,SkeletonRows } from '../components/ui';
import { toast } from '../components/toast';
import { accountStore,queryClient,rpc,useAccountQuery,useCurrentAccount,useCurrentConversation } from '../data/client';
import { budgetDraft,budgetValues } from './budgetDraft';
import type { BudgetDraft,DefaultLimits } from './budgetDraft';
import { useSettingsDraft } from './SettingsDraftGuard';

type BudgetView=DefaultLimits&{chat_unlimited:boolean;chat_configured:boolean;
  conversation?:{limit:number;unlimited:boolean;used:number;remaining:number|null}};
const FIELDS=[['max_model_calls','普通文章默认上限','1–100次 / 新任务',1,100],
  ['max_image_model_calls','补图任务默认上限','1–100次 / 新补图任务',1,100],
  ['max_chat_calls','会话模型调用上限','0–1000次 / 会话；0表示不限制',0,1000]] as const;

export function DefaultBudgetPanel() {
  const account=useCurrentAccount(),conversation=useCurrentConversation();
  const budget=useAccountQuery<BudgetView>('budgets.get',conversation?{conversation_id:conversation}:{},{staleTime:0});
  const [draft,setDraft]=React.useState<BudgetDraft|null>(null),[base,setBase]=React.useState<BudgetView|null>(null);
  const [busy,setBusy]=React.useState(''),[error,setError]=React.useState<string|null>(null),[reload,setReload]=React.useState<BudgetView|null>(null);
  const active=React.useRef(true),busyRef=React.useRef(false);
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const dirty=Boolean(draft&&base&&JSON.stringify(draft)!==JSON.stringify(budgetDraft(base)));
  const install=(data:BudgetView)=>{setBase(data);setDraft(budgetDraft(data));setError(null);setReload(null);};
  const guard=useSettingsDraft('budget','全局预算',dirty,Boolean(busy),()=>{
    if(budget.data)install(budget.data);
  });
  React.useEffect(()=>{if(!base&&budget.data)install(budget.data);},[base,budget.data]);
  const valid=()=>active.current&&accountStore.get()===account;
  const perform=async(label:string,action:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;guard.processing();setBusy(label);setError(null);
    try{await action();}catch(problem){if(valid())setError((problem as Error).message);}
    finally{busyRef.current=false;if(valid())setBusy('');}
  };
  const save=()=>void perform('正在保存全局预算…',async()=>{
    if(!draft||!base?.defaults_hash)throw Error('尚未读到预算版本，请载入最新预算后重试');
    const values=budgetValues(draft);
    const result=await rpc<BudgetView>('budgets.save',{scope:'defaults',account_id:account,defaults_hash:base.defaults_hash,...values});
    if(!valid())return;
    install(result);
    await Promise.all([
      queryClient.invalidateQueries({queryKey:['ice',account,'budgets.get']}),
      queryClient.invalidateQueries({queryKey:['ice',account,'bootstrap']}),
    ]);
    if(valid())toast.success({title:'全局预算已保存',detail:'新文章和补图任务使用新上限；已有任务保留本篇预算，已用次数不清零。'});
  });
  const read=()=>void perform('正在读取最新预算…',async()=>{
    const result=await budget.refetch();if(result.error)throw result.error;
    if(!valid()||!result.data)return;
    if(dirty)setReload(result.data);else install(result.data);
  });
  const changed=(key:keyof BudgetDraft,value:string)=>{guard.changed();setDraft(previous=>previous&&({...previous,[key]:value}));};
  return <section aria-label="模型调用预算" style={{display:'grid',gap:12,marginBottom:24,paddingBottom:20,borderBottom:'1px solid var(--ice-border)'}}>
    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}><strong data-budget-heading tabIndex={-1}>全局默认预算</strong><span className="ice-badge">此电脑的所有公众号</span></div>
    <p style={{margin:0,fontSize:'var(--ice-font-size-sm)',color:'var(--ice-text-secondary)',lineHeight:1.65}}>
      普通文章与补图上限只影响之后创建的任务，已有文章在配图工作台调整本篇预算。会话上限保存后立即适用于已有会话，已用次数不清零。每次真实模型请求计一次，失败重试也计入；能力不匹配的请求不计入。</p>
    {budget.isLoading&&<SkeletonRows rows={3} height={32} />}
    {budget.error&&<Banner tone="danger" title="预算读取失败">{budget.error.message}<Button size="sm" onClick={read}>重试读取预算</Button></Banner>}
    {draft&&<fieldset disabled={Boolean(busy)} style={{border:0,padding:0,margin:0,display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(180px,100%),1fr))',gap:12,minWidth:0}}>
      {FIELDS.map(([key,label,hint,min,max])=><label key={key} className="ice-card ice-card--compact" style={{gap:6,padding:12,minWidth:0}}>
        <strong style={{fontSize:'var(--ice-font-size-sm)'}}>{label}</strong>
        <Input aria-label={label} type="number" step={1} min={min} max={max} value={draft[key]} onChange={event=>changed(key,event.target.value)} />
        <small style={{color:'var(--ice-text-secondary)'}}>{hint}</small>
      </label>)}
    </fieldset>}
    {base&&!base.chat_configured&&<small style={{color:'var(--ice-text-secondary)'}}>会话尚未单独配置，当前按默认24次执行；留空不能代替0。</small>}
    {budget.data?.conversation&&<div className="ice-badge" role="status">当前会话已用{budget.data.conversation.used}次 · {budget.data.conversation.unlimited?'不限制':`剩余${budget.data.conversation.remaining}次`}</div>}
    {budget.data&&base&&budget.data.defaults_hash!==base.defaults_hash&&<Banner tone="warning" title="预算已有更新">当前输入保持不变。请载入最新预算，确认后再保存。</Banner>}
    {error&&<Banner tone="danger" title="预算尚未保存">{error}</Banner>}
    {reload&&<Banner tone="warning" title="是否放弃预算修改？">载入后会替换这三个预算输入，其他模型设置保持不变。
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:8}}><Button size="sm" onClick={()=>setReload(null)}>保留预算修改</Button><Button size="sm" variant="danger" onClick={()=>install(reload)}>放弃预算修改并载入</Button></div>
    </Banner>}
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <Button variant="primary" loading={Boolean(busy)} disabled={!draft||!dirty} onClick={save}>保存全局预算</Button>
      <Button disabled={Boolean(busy)} onClick={read}>载入最新预算</Button>
      <span role="status" style={{fontSize:'var(--ice-font-size-sm)',color:'var(--ice-text-secondary)'}}>{busy||(dirty?'预算修改尚未保存':'预算按引擎账本执行')}</span>
    </div>
  </section>;
}
