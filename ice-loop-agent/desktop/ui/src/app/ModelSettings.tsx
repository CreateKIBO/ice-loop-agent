// 模型与 Key（新工作台内的最小可用设置）：新装用户不用切回经典界面就能开始写。
// 本页编辑文字分工与全局预算，视觉/思考策略仍保留经典入口；保护未保存输入。
import * as React from "react";
import { motion, useAnimationControls } from "motion/react";

import { Button, Dialog, Input, SkeletonRows } from "../components/ui";
import { toast } from "../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery, useCurrentAccount, type RpcError } from "../data/client";
import { switchToClassic } from "../data/desktop";
import { settingsStore } from "./uiState";
import { DefaultBudgetPanel } from './DefaultBudgetPanel';
import { SettingsDraftContext,useSettingsDraft } from './SettingsDraftGuard';
import { createSettingsDrafts } from './settingsDrafts';
import { writingReadiness, type ModelRoute } from './modelRoutes';
import { TextModelRoutes } from './TextModelRoutes';
import { ModelGenerationLimits } from './ModelGenerationLimits';

export type ModelProfile = {
  provider: string; profile_id: string; model_id: string; base_url: string;
  status: string; has_key: boolean;
  limits_hash?:string;
  extra?:{max_output_tokens?:number|null;model_window?:{model_id:string;base_url:string;context_window?:number;max_output_tokens?:number;checked_at?:string;state?:string}};
};
export type BootstrapSettings = {
  version?: string;
  account?: { id: string; name: string; audience?: string; positioning?: string; library_root?: string;
    columns?: Array<{code:string;name:string}> };
  accounts?: Array<{id:string;name:string}>;
  account_hash?: string;
  routes_hash?: string;
  credential_warning?: string | null;
  settings?: { profiles: ModelProfile[]; routes?: Record<string, ModelRoute> };
};

const PROVIDERS: Record<string, { mark: string; name: string; service: string }> = {
  qwen: { mark: "Q", name: "通义千问", service: "阿里云百炼" },
  deepseek: { mark: "D", name: "DeepSeek", service: "原厂 API" },
  kimi: { mark: "K", name: "Kimi", service: "Moonshot 中国平台" },
  bigmodel: { mark: "G", name: "GLM", service: "智谱 BigModel" },
  ark: { mark: "豆", name: "豆包", service: "火山方舟" },
  minimax: { mark: "M", name: "MiniMax", service: "MiniMax 开放平台" },
};

export function useBootstrap() {
  return useAccountQuery<BootstrapSettings>("bootstrap", {}, { staleTime: 60_000 });
}

/** Readiness follows the same writer primary/fallback chain used by the real request. */
export function useModelReadiness() {
  const boot = useBootstrap();
  return writingReadiness(boot.data?.settings);
}

const refreshBootstrap = (account:string) =>
  queryClient.invalidateQueries({ queryKey: ["ice", account, "bootstrap"] });

export function ModelSettings() {
  const open = settingsStore.use();
  const account=useCurrentAccount(),[drafts]=React.useState(createSettingsDrafts);
  React.useSyncExternalStore(drafts.subscribe,drafts.version);
  const [pending,setPending]=React.useState<'close'|'classic'|null>(null),[closeError,setCloseError]=React.useState<string|null>(null);
  const status=drafts.status();
  React.useEffect(()=>{if(!open){setPending(null);setCloseError(null);}},[open]);
  const finish=async(target:'close'|'classic')=>{
    try{if(target==='classic')await switchToClassic();settingsStore.set(false);}
    catch(problem){setCloseError((problem as Error).message);}
  };
  const close=(target:'close'|'classic')=>{
    setCloseError(null);
    const latest=drafts.status();
    if(latest.busy){setCloseError('设置正在保存或测试，请等待完成后再离开');return;}
    if(latest.dirty){setPending(target);return;}
    void finish(target);
  };
  const discard=()=>{
    if(!pending)return;
    try{drafts.discard();const target=pending;setPending(null);void finish(target);}
    catch(problem){setCloseError((problem as Error).message);}
  };
  const boot = useAccountQuery<BootstrapSettings>("bootstrap", {}, { enabled: open, staleTime: 0 });
  const profiles = boot.data?.settings?.profiles ?? [];
  const writer = boot.data?.settings?.routes?.writer?.primary;

  return (
    <SettingsDraftContext.Provider value={drafts}>
    <Dialog open={open} onOpenChange={next=>{if(!next)close('close');}} title="模型与 Key" width={800} initialFocus="[data-budget-heading]"
            description="全局调用预算、国内模型与 Key 均在此设置。保存 Key 后可手动测试连接；测试会发送真实请求。Key 由系统加密保存。"
            footer={pending?<>
              <span role="status" style={{flex:1,fontSize:'var(--ice-font-size-sm)'}}>模型或预算有未保存修改。</span>
              <Button onClick={()=>setPending(null)}>继续设置</Button>
              <Button variant="danger" disabled={status.busy} onClick={discard}>放弃未保存设置并离开</Button>
            </>:<>
              <span style={{ flex: 1, color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
                文字分工可在此设置；视觉模型与思考策略可在经典界面调整。
              </span>
              <Button variant="ghost" onClick={() => close('classic')}>
                去经典界面
              </Button>
              <Button variant="primary" onClick={() => close('close')}>完成</Button>
            </>}>
      {closeError&&<div role="alert" className="ice-error-text">{closeError}</div>}
      <DefaultBudgetPanel key={'budget:'+account} />
      <TextModelRoutes key={'routes:'+account} snapshot={boot.data} onRefresh={() => boot.refetch()} />
      <h3 style={{margin:'0 0 12px',fontSize:'var(--ice-font-size-md)'}}>供应商与模型</h3>
      {boot.isLoading && <SkeletonRows rows={6} height={18} />}
      {boot.error && (
        <div role="alert" className="ice-error-text">
          读取设置失败：{(boot.error as RpcError).message}
          <button type="button" className="ice-link-btn" style={{ marginLeft: 8 }} onClick={() => boot.refetch()}>重试</button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))", gap: "var(--ice-space-3)" }}>
        {profiles.map((profile, index) => (
          <motion.div key={account+':'+profile.provider} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ minWidth: 0 }}
                      transition={{ delay: index * 0.04, duration: 0.2 }}>
            <ProviderCard profile={profile} usedForWriting={writer === profile.profile_id} />
          </motion.div>
        ))}
      </div>
    </Dialog>
    </SettingsDraftContext.Provider>
  );
}

function ProviderCard({ profile, usedForWriting }: { profile: ModelProfile; usedForWriting: boolean }) {
  const account=useCurrentAccount();
  const meta = PROVIDERS[profile.provider] ?? { mark: profile.provider.slice(0, 1).toUpperCase(), name: profile.provider, service: "" };
  const [modelId, setModelId] = React.useState(profile.model_id);
  const [baseModel,setBaseModel]=React.useState(profile.model_id);
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState<"key" | "model" | "probe" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const active=React.useRef(true),busyRef=React.useRef(false);
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const current=()=>active.current&&accountStore.get()===account;
  const guard=useSettingsDraft('provider:'+profile.provider,meta.name+'设置',Boolean(key)||modelId!==baseModel,busy!==null,()=>{
    setKey('');setModelId(profile.model_id);setBaseModel(profile.model_id);setError(null);
  });
  const shake = useAnimationControls();

  const fail = (message: string) => {
    setError(message);
    void shake.start({ x: [0, -6, 6, -4, 4, 0], transition: { duration: 0.32 } });
  };

  const saveKey = async () => {
    if (!key.trim() || busyRef.current) return;
    if (!window.ice?.saveKey) { fail("当前环境不支持保存 Key"); return; }
    busyRef.current=true;guard.processing();
    setBusy("key"); setError(null);
    try {
      await window.ice.saveKey(profile.provider, key.trim());
      if(!current())return;
      setKey("");
      toast.success({ title: `${meta.name} Key 已加密保存`, detail: "建议点「测试连接」确认可用" });
      await refreshBootstrap(account);
    } catch (err) { if(current())fail((err as Error).message); }
    finally { busyRef.current=false;if(current())setBusy(null); }
  };

  const persistModel=async()=>{
    const model=modelId.trim();if(!model||model.length>160)throw Error('请输入1–160字的模型ID');
    await rpc('models.save',{provider:profile.provider,model_id:model,expected_model_id:baseModel,account_id:account});
    if(current()){setModelId(model);setBaseModel(model);}
    await refreshBootstrap(account);
  };
  const saveModel=async()=>{
    if(busyRef.current)return;
    busyRef.current=true;guard.processing();setBusy('model');setError(null);
    try{await persistModel();if(current())toast.success({title:meta.name+'模型已保存',detail:'尚未发送模型请求，可按需测试连接。'});}
    catch(problem){if(current())fail((problem as Error).message);}
    finally{busyRef.current=false;if(current())setBusy(null);}
  };
  const reloadModel=async()=>{
    if(busyRef.current)return;
    busyRef.current=true;guard.processing();setBusy('model');setError(null);
    try{
      const result=await rpc<BootstrapSettings>('bootstrap');
      if(!current())return;
      const latest=result.settings?.profiles.find(row=>row.provider===profile.provider);
      if(!latest)throw Error('未找到该供应商的已保存配置');
      setModelId(latest.model_id);setBaseModel(latest.model_id);await refreshBootstrap(account);
    }catch(problem){if(current())fail((problem as Error).message);}
    finally{busyRef.current=false;if(current())setBusy(null);}
  };

  const probe = async () => {
    if (busyRef.current) return;
    if(key){fail('请先保存或清空当前输入的Key，再测试连接');return;}
    busyRef.current=true;guard.processing();
    setBusy("probe"); setError(null);
    try {
      if (modelId !== baseModel) await persistModel();
      const result = await rpc<{ model: string }>("models.probe", { provider: profile.provider });
      if(!current())return;
      toast.success({ title: `${meta.name} 连接通过`, detail: "实际模型：" + result.model });
      await refreshBootstrap(account);
    } catch (err) { if(current())fail((err as Error).message); }
    finally { busyRef.current=false;if(current())setBusy(null); }
  };

  const status = profile.status === "verified" && profile.has_key
    ? { label: "连接已验证", tone: "success" }
    : profile.has_key ? { label: "可测试连接", tone: "warning" } : { label: "未配置 Key", tone: "" };

  return (
    <motion.section animate={shake} className={"ice-card" + (profile.status === "verified" && profile.has_key ? " ice-card--selected" : "")}
                    aria-label={meta.name} style={{ gap: 10, padding: "var(--ice-space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden style={{
          width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", fontWeight: 700,
          background: "var(--ice-ink)", color: "var(--ice-warm-white)", flexShrink: 0,
        }}>{meta.mark}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{meta.name}</strong>
          <div style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>{meta.service}</div>
        </div>
        {usedForWriting && <span className="ice-badge ice-badge--info" title="当前创作对话与正文的主模型">正文使用</span>}
        <span className={"ice-badge" + (status.tone ? " ice-badge--" + status.tone : "")}>{status.label}</span>
      </div>
      <label style={{ display: "grid", gap: 4, fontSize: "var(--ice-font-size-sm)" }}>
        模型 ID
        <Input value={modelId} maxLength={160} disabled={busy!==null} onChange={event => {guard.changed();setModelId(event.target.value);}} aria-label={meta.name + " 模型 ID"} />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: "var(--ice-font-size-sm)" }}>
        API Key
        <div style={{ display: "flex", gap: 6 }}>
          <Input type="password" autoComplete="off" value={key} disabled={busy!==null} style={{ flex: 1, minWidth: 0 }}
                 onChange={event => {guard.changed();setKey(event.target.value);}}
                 onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveKey(); } }}
                 placeholder={profile.has_key ? "已配置 · 留空保持原 Key" : "粘贴供应商控制台的 Key"}
                 aria-label={meta.name + " API Key"} />
          <Button loading={busy === "key"} disabled={!key.trim() || busy !== null} onClick={saveKey}>保存 Key</Button>
        </div>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8,flexWrap:'wrap' }}>
        <Button loading={busy==='model'} disabled={busy!==null||!modelId.trim()||modelId===baseModel} onClick={saveModel}>保存模型</Button>
        <Button variant={profile.has_key && profile.status !== "verified" ? "primary" : "secondary"}
                loading={busy === "probe"} disabled={!profile.has_key || busy !== null || !modelId.trim()||Boolean(key)}
                title={profile.has_key ? "发送一次短请求验证 Key 和模型 ID，可能产生少量费用" : "先保存 Key"}
                onClick={probe}>测试连接</Button>
        <span style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)", overflow: "hidden",
                       textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={profile.base_url}>
          {profile.base_url}
        </span>
      </div>
      {(modelId!==baseModel||profile.model_id!==baseModel)&&<Button size="sm" variant="ghost" disabled={busy!==null} onClick={reloadModel}>放弃当前模型输入并载入</Button>}
      <small style={{color:'var(--ice-text-secondary)',lineHeight:1.6}}>保存模型不会发起生成。测试连接会发送一次真实请求并计数，可能产生费用。</small>
      <ModelGenerationLimits profile={profile} disabled={busy!==null||modelId!==baseModel||Boolean(key)} refresh={()=>refreshBootstrap(account)} />
      {busy&&<span role="status">{busy==='key'?'正在加密保存Key…':busy==='model'?'正在处理模型配置…':'正在请求供应商验证连接…'}</span>}
      {error && <div role="alert" className="ice-error-text">{error}</div>}
    </motion.section>
  );
}
