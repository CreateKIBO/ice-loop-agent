import * as React from 'react';
import { Button, Input } from '../components/ui';
import { accountStore, rpc, useCurrentAccount } from '../data/client';
import { useSettingsDraft } from './SettingsDraftGuard';
import type { BootstrapSettings, ModelProfile } from './ModelSettings';

const outputText=(profile:ModelProfile)=>profile.extra?.max_output_tokens==null?'':String(profile.extra.max_output_tokens);

export function ModelGenerationLimits({profile,disabled,refresh}:{profile:ModelProfile;disabled:boolean;refresh:()=>Promise<unknown>}) {
  const account=useCurrentAccount(),[base,setBase]=React.useState(profile),[value,setValue]=React.useState(()=>outputText(profile));
  const [busy,setBusy]=React.useState<'save'|'read'|'reload'|null>(null),[error,setError]=React.useState<string|null>(null);
  const alive=React.useRef(true),working=React.useRef(false),dirty=value!==outputText(base);
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const current=()=>alive.current&&accountStore.get()===account;
  const install=(next:ModelProfile)=>{setBase(next);setValue(outputText(next));setError(null);};
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
        let maximum:number|null=null;
        if(kind==='save'&&value!==''){
          if(!/^[1-9]\d*$/.test(value)||Number(value)>1_000_000)throw Error('最大输出Token需为1–1,000,000的整数；留空使用供应商默认值');
          maximum=Number(value);
        }
        result=await rpc<BootstrapSettings>(kind==='save'?'models.limits_save':'models.window_refresh',{
          account_id:account,provider:profile.provider,limits_hash:base.limits_hash,
          ...(kind==='save'?{max_output_tokens:maximum}:{})});
      }
      if(!current())return;
      const next=result.settings?.profiles.find(row=>row.provider===profile.provider);
      if(!next)throw Error('模型配置已移除，请重新打开设置');
      install(next);await refresh();
    }catch(problem){if(current())setError((problem as Error).message);}
    finally{working.current=false;if(current())setBusy(null);}
  };
  return <details className="ice-generation-limits">
    <summary>输出与窗口{dirty?' · 未保存':''}</summary>
    <label>最大输出 Token
      <Input aria-label={profile.provider+' 最大输出 Token'} type="text" inputMode="numeric" value={value} maxLength={8}
        placeholder="留空使用供应商默认值" disabled={disabled||busy!==null}
        onChange={event=>{guard.changed();setValue(event.target.value);}} />
    </label>
    <div className="ice-generation-limits__actions">
      <Button size="sm" loading={busy==='save'} disabled={disabled||busy!==null||!dirty||changed} onClick={()=>void run('save')}>保存输出设置</Button>
      <Button size="sm" loading={busy==='read'} disabled={disabled||busy!==null||dirty||changed||!profile.has_key}
        title="向当前端点读取模型列表；不发起文章生成，也不验证写作或识图能力" onClick={()=>void run('read')}>读取模型窗口</Button>
      {(dirty||changed)&&<Button size="sm" variant="ghost" disabled={busy!==null} onClick={()=>void run('reload')}>载入已保存输出设置</Button>}
    </div>
    {disabled&&<p>请先保存或清空模型与 Key 的修改，再设置输出。</p>}
    {changed&&<p role="status">模型或设置已经变化，当前输入已保留。请载入已保存设置后重新确认。</p>}
    <dl><div><dt>上次读取的上下文窗口</dt><dd>{count('context_window')} Token</dd></div>
      <div><dt>上次读取的最大输出</dt><dd>{count('max_output_tokens')} Token</dd></div></dl>
    {scoped&&window?.checked_at&&<p>读取时间：{window.checked_at}；来源：当前端点 /models。</p>}
    {scoped&&window?.state!=='reported'&&<p>{window?.state==='model_not_listed'?'接口没有列出当前模型，请核对模型ID。':window?.state==='ambiguous_model'?'接口返回了重复模型ID，窗口信息未采用。':'接口未提供当前模型的窗口参数，仍可手动配置输出。'}</p>}
    <p>留空沿用供应商默认值。此处控制输出上限，不保证输出长度；输入 Token 尚未精确计算。窗口未知时请核对供应商文档，不能把字符数视为 Token。</p>
    {busy&&<p role="status">{busy==='read'?'正在读取当前端点的模型信息…':'正在处理输出设置…'}</p>}
    {error&&<p role="alert" className="ice-error-text">{error}</p>}
  </details>;
}
