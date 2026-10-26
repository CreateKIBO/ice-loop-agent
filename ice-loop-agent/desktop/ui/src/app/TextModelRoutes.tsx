import * as React from 'react';
import { Banner,Button,SkeletonRows } from '../components/ui';
import { toast } from '../components/toast';
import { accountStore,queryClient,rpc,useCurrentAccount } from '../data/client';
import { useSettingsDraft } from './SettingsDraftGuard';
import { assignPrimary,textRoutes,TEXT_ROLES,type ModelRoute } from './modelRoutes';
import type { BootstrapSettings } from './modelBootstrap';

export function TextModelRoutes({snapshot,onRefresh}:{snapshot?:BootstrapSettings;onRefresh:()=>Promise<unknown>}) {
  const account=useCurrentAccount();
  const [draft,setDraft]=React.useState<Record<string,ModelRoute>>({}),[base,setBase]=React.useState(''),[hash,setHash]=React.useState('');
  const [choice,setChoice]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState<string|null>(null);
  const [confirmReload,setConfirmReload]=React.useState(false);
  const active=React.useRef(true),processing=React.useRef(false);
  const dirty=Boolean(base&&JSON.stringify(draft)!==base);
  const profiles=snapshot?.settings?.profiles??[];
  const install=(value:BootstrapSettings)=>{
    const next=textRoutes(value.settings?.routes);
    setDraft(next);setBase(JSON.stringify(next));setHash(value.routes_hash||'');setError(null);setConfirmReload(false);
  };
  const guard=useSettingsDraft('routes','文字模型分工',dirty,busy,()=>{setDraft(JSON.parse(base||'{}'));setError(null);setConfirmReload(false);});
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  React.useEffect(()=>{if(snapshot?.account?.id===account&&snapshot.routes_hash&&!dirty&&!processing.current)install(snapshot);},[snapshot,dirty,account]); // Saved snapshots never replace an edited draft.
  const current=()=>active.current&&accountStore.get()===account;
  const save=async()=>{
    if(processing.current||!dirty||!hash)return;
    processing.current=true;guard.processing();setBusy(true);setError(null);
    try{
      const result=await rpc<BootstrapSettings>('models.routes_save',{account_id:account,routes_hash:hash,routes:draft});
      if(!current())return;
      if(result.account?.id!==account)throw Error('公众号已变化，请重新打开设置查看最新分工');
      install(result);
      queryClient.setQueryData(['ice',account,'bootstrap',{}],result);
      toast.success({title:'文字模型分工已保存',detail:'后续对话与新建任务使用此分工，已有任务保留原配置。'});
      await onRefresh();
    }catch(problem){if(current())setError((problem as Error).message);}
    finally{processing.current=false;if(current())setBusy(false);}
  };
  const reload=async()=>{
    if(processing.current)return;
    processing.current=true;guard.processing();setBusy(true);setError(null);
    try{const result=await rpc<BootstrapSettings>('bootstrap');if(current()){
      if(result.account?.id!==account)throw Error('公众号已变化，当前选择保留，请重新打开设置');
      install(result);queryClient.setQueryData(['ice',account,'bootstrap',{}],result);
    }}
    catch(problem){if(current())setError((problem as Error).message);}
    finally{processing.current=false;if(current())setBusy(false);}
  };
  const assign=(primary:string,role?:string)=>{guard.changed();setConfirmReload(false);setDraft(previous=>assignPrimary(previous,primary,role));};
  const profileLabel=(id:string)=>{const profile=profiles.find(row=>row.profile_id===id);return profile?`${profile.provider} · ${profile.model_id}${profile.has_key?'':' · 未配置Key'}`:id;};
  return <section className="ice-model-routes" aria-label="文字模型分工" aria-busy={busy}>
    <div className="ice-model-routes__heading"><div><h3>文字模型分工</h3><p>适用于所有公众号的后续创作；已建立的制作任务保留原配置。先配置Key，再把模型接入文字分工。</p></div>
      <span className={'ice-badge'+(dirty?' ice-badge--warning':'')}>{dirty?'选择尚未保存':'当前已保存'}</span></div>
    {!hash?<SkeletonRows rows={2} height={30}/>:<>
      <fieldset disabled={busy} className="ice-model-routes__fields">
        <div className="ice-model-routes__quick"><label><span>一个模型负责全部文字环节</span>
          <select aria-label="统一文字模型" value={choice} onChange={event=>setChoice(event.target.value)}>
            <option value="">选择供应商与模型</option>{profiles.map(profile=><option key={profile.profile_id} value={profile.profile_id}>{profileLabel(profile.profile_id)}</option>)}
          </select></label>
          <Button size="sm" disabled={!choice} onClick={()=>assign(choice)}>应用到文字环节</Button></div>
        <p className="ice-model-routes__note">保留各环节的思考策略和其他回退模型；不更改识图模型，也不会发送模型请求。</p>
        <details><summary>按环节调整 · {TEXT_ROLES.filter(role=>draft[role.id]).length} 项</summary>
          <div className="ice-model-routes__grid">{TEXT_ROLES.filter(role=>draft[role.id]).map(role=><label key={role.id}><span>{role.label}</span>
            <select aria-label={`${role.label}模型`} value={draft[role.id].primary} onChange={event=>assign(event.target.value,role.id)}>
              {profiles.map(profile=><option key={profile.profile_id} value={profile.profile_id}>{profileLabel(profile.profile_id)}</option>)}
            </select>
            <small>回退：{draft[role.id].fallbacks.map(profileLabel).join(' → ')||'无'}</small>
          </label>)}</div>
        </details>
      </fieldset>
      {error&&<div role="alert" className="ice-error-text">{error}</div>}
      {confirmReload&&<Banner tone="warning" title="载入将替换未保存的分工选择">
        <div className="ice-model-routes__actions"><Button size="sm" onClick={()=>setConfirmReload(false)}>保留选择</Button><Button size="sm" onClick={()=>void reload()}>确认载入最新</Button></div>
      </Banner>}
      <div className="ice-model-routes__actions"><Button size="sm" disabled={busy} onClick={()=>dirty?setConfirmReload(true):void reload()}>载入最新分工</Button>
        <span style={{flex:1}}/><Button variant="primary" size="sm" loading={busy} disabled={!dirty||!hash} onClick={()=>void save()}>保存模型分工</Button></div>
    </>}
  </section>;
}
