import * as React from 'react';
import { Button, Input } from '../components/ui';
import { ErrorNote } from '../components/ErrorNote';
import { errorDisplay } from '../components/errorText';
import { refreshAfterWrite } from '../data/receipts';
import { accountStore, queryClient, rpc, useCurrentAccount } from '../data/client';
import { useSettingsDraft } from './SettingsDraftGuard';
import type { BootstrapSettings, ModelProfile } from './modelBootstrap';

const outputText=(profile:ModelProfile)=>profile.extra?.max_output_tokens==null?'':String(profile.extra.max_output_tokens);

const contextText=(profile:ModelProfile)=>{const manual=profile.extra?.context_window_override;return manual?.model_id===profile.model_id&&manual.base_url===profile.base_url.replace(/\/$/,'')?String(manual.context_window):'';};
const checkPolicy=(profile:ModelProfile)=>profile.extra?.token_check??'auto';

export function ModelGenerationLimits({profile,disabled,refresh}:{profile:ModelProfile;disabled:boolean;refresh:()=>Promise<unknown>}) {
  const account=useCurrentAccount(),[base,setBase]=React.useState(profile),[value,setValue]=React.useState(()=>outputText(profile));
  const [contextValue,setContextValue]=React.useState(()=>contextText(profile)),[policy,setPolicy]=React.useState(()=>checkPolicy(profile));
  const [busy,setBusy]=React.useState<'save'|'read'|'reload'|null>(null),[error,setError]=React.useState<unknown>(null);
  const alive=React.useRef(true),working=React.useRef(false),dirty=value!==outputText(base)||contextValue!==contextText(base)||policy!==checkPolicy(base);
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const current=()=>alive.current&&accountStore.get()===account;
  const install=(next:ModelProfile)=>{setBase(next);setValue(outputText(next));setContextValue(contextText(next));setPolicy(checkPolicy(next));setError(null);};
  React.useEffect(()=>{if(!dirty&&!busy&&profile.limits_hash!==base.limits_hash)install(profile);},[profile,dirty,busy,base.limits_hash]);
  const guard=useSettingsDraft('generation:'+profile.provider,'模型输出设置',dirty,busy!==null,()=>install(profile));
  const changed=base.limits_hash!==profile.limits_hash;
  const window=base.extra?.model_window;
  const scoped=window?.model_id===base.model_id&&window?.base_url===base.base_url.replace(/\/$/,'');
  const count=(field:'context_window'|'max_output_tokens')=>scoped&&typeof window?.[field]==='number'?window[field]!.toLocaleString():'未知';
  const run=async(kind:'save'|'read'|'reload')=>{
    if(working.current)return;
    working.current=true;guard.processing();setBusy(kind);setError(null);
    try{
      let result:BootstrapSettings;
      if(kind==='reload')result=await rpc<BootstrapSettings>('bootstrap');
      else {
        let maximum:number|null=null,contextWindow:number|null=null;
        if(kind==='save'&&value!==''){
          if(!/^[1-9]\d*$/.test(value)||Number(value)>1_000_000)throw Error('最大输出Token需为1–1,000,000的整数；留空使用供应商默认值');
          maximum=Number(value);
        }
        if(kind==='save'&&contextValue!==''){
          if(!/^[1-9]\d*$/.test(contextValue)||Number(contextValue)>2_147_483_647)throw Error('手动上下文窗口需为1–2,147,483,647的整数；留空使用端点报告值');
          contextWindow=Number(contextValue);
        }
        result=await rpc<BootstrapSettings>(kind==='save'?'models.limits_save':'models.window_refresh',{
          account_id:account,provider:profile.provider,limits_hash:base.limits_hash,
          ...(kind==='save'?{max_output_tokens:maximum,context_window:contextWindow,token_check:policy}:{})});
      }
      if(!current())return;
      const next=result.settings?.profiles.find(row=>row.provider===profile.provider);
      if(!next)throw Error('模型配置已移除，请重新打开设置');
      // The acknowledged bootstrap is authoritative even if the following read fails.
      // Cancel older reads so stale props cannot roll this form back after saving.
      if(result.account?.id===account){
        await queryClient.cancelQueries({queryKey:['ice',account,'bootstrap']});
        if(!current())return;
        queryClient.setQueryData(['ice',account,'bootstrap',{}],result);
      }
      install(next);await refreshAfterWrite(kind==='save'?'模型输出与预检设置保存':'模型窗口读取',async()=>{
        if(!current())return;
        try{await refresh();}catch(problem){if(current())throw problem;}
      });
    }catch(problem){if(current())setError(problem);}
    finally{working.current=false;if(current())setBusy(null);}
  };
  return <details className="ice-generation-limits">
    <summary>输出与窗口{dirty?' · 未保存':''}</summary>
    <label>最大输出 Token
      <Input aria-label={profile.provider+' 最大输出 Token'} type="text" inputMode="numeric" value={value} maxLength={8}
        placeholder="留空使用供应商默认值" disabled={disabled||busy!==null}
        onChange={event=>{guard.changed();setValue(event.target.value);}} />
    </label>
    <label>手动上下文窗口 Token
      <Input aria-label={profile.provider+' 手动上下文窗口 Token'} type="text" inputMode="numeric" value={contextValue} maxLength={10}
        placeholder="留空使用端点报告值" disabled={disabled||busy!==null}
        onChange={event=>{guard.changed();setContextValue(event.target.value);}} />
    </label>
    <p>仅在端点未报告或需纠正窗口时填写，以当前模型官方说明为准。手动值优先，切换模型或端点后失效。</p>
    <label>调用前 Token 预检
      <select className="ice-generation-limits__select" aria-label={profile.provider+' Token 预检策略'} value={policy} disabled={disabled||busy!==null}
        onChange={event=>{guard.changed();setPolicy(event.target.value as 'auto'|'required'|'off');}}>
        <option value="auto">自动：支持时计数，未知时保留说明</option>
        <option value="required">严格：计数与输入加输出核验均须通过</option>
        <option value="off">关闭供应商计数</option>
      </select>
    </label>
    <p role="status">{base.token_count_supported?'当前端点与模型已接通供应商计数。':'当前端点或模型的供应商计数尚未接通；严格模式会阻止生成。'}计数是附加供应商请求，费用以供应商为准。</p>
    <div className="ice-generation-limits__actions">
      <Button size="sm" loading={busy==='save'} disabled={disabled||busy!==null||!dirty||changed} onClick={()=>void run('save')}>保存输出设置</Button>
      <Button size="sm" loading={busy==='read'} disabled={disabled||busy!==null||dirty||changed||!profile.has_key}
        title="向当前端点读取模型列表；不发起文章生成，也不验证写作或识图能力" onClick={()=>void run('read')}>读取模型窗口</Button>
      {(dirty||changed)&&<Button size="sm" variant="ghost" disabled={busy!==null} onClick={()=>void run('reload')}>载入已保存输出设置</Button>}
    </div>
    {disabled&&<p>请先保存或清空模型与 Key 的修改，再设置输出。</p>}
    {changed&&<p role="status">模型或设置已经变化，当前输入已保留。请载入已保存设置后重新确认。</p>}
    <dl><div><dt>当前用于预检的窗口</dt><dd>{contextText(base)?Number(contextText(base)).toLocaleString():count('context_window')} Token{contextText(base)?'（手动）':''}</dd></div>
      <div><dt>上次读取的上下文窗口</dt><dd>{count('context_window')} Token</dd></div>
      <div><dt>上次读取的最大输出</dt><dd>{count('max_output_tokens')} Token</dd></div></dl>
    {scoped&&window?.checked_at&&<p>读取时间：{window.checked_at}；来源：当前端点 /models。</p>}
    {scoped&&window?.state!=='reported'&&<p>{window?.state==='model_not_listed'?'接口没有列出当前模型，请核对模型ID。':window?.state==='ambiguous_model'?'接口返回了重复模型ID，窗口信息未采用。':'接口未提供当前模型的窗口参数，仍可手动配置输出。'}</p>}
    <p>最大输出留空沿用供应商默认值，不保证实际长度。自动模式在已支持模型上计数；仅窗口和输出预留均明确时核验总量，未知不代表通过。严格模式需补齐两项，且要求已配置备用模型也通过同等核验。不会自动截掉前五篇全文或历史标题；字符保护仍独立生效。</p>
    {busy&&<p role="status">{busy==='read'?'正在读取当前端点的模型信息…':'正在处理输出设置…'}</p>}
    {error!=null&&<ErrorNote error={error} note={'当前输入已保留。'+errorDisplay(error).diagnostic} />}
  </details>;
}
