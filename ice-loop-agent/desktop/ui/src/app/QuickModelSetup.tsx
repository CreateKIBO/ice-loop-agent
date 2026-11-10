// P1 模型初次配置的简单路径：一个供应商、一个模型、一个 Key → 接入全部文字环节 → 测试连接。
// 多供应商、角色分工、预算与生成上限保留在“高级设置”里，不删除也不改变其语义。
import * as React from "react";

import { Button, Input } from "../components/ui";
import { ErrorNote } from "../components/ErrorNote";
import { toast } from "../components/toast";
import { accountStore, queryClient, rpc, useCurrentAccount } from "../data/client";
import { useSettingsDraft } from "./SettingsDraftGuard";
import { assignPrimary, textRoutes, writingReadiness } from "./modelRoutes";
import type { BootstrapSettings, ModelProfile } from "./modelBootstrap";

type Step = "key" | "model" | "routes" | "probe";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "key", label: "加密保存 Key" }, { id: "model", label: "保存模型" },
  { id: "routes", label: "接入全部文字环节" }, { id: "probe", label: "测试连接" },
];

export function QuickModelSetup({ snapshot, providers, onDone }: {
  snapshot?: BootstrapSettings; providers: Record<string, { name: string; service: string }>; onDone: () => Promise<unknown>;
}) {
  const account = useCurrentAccount();
  const profiles: ModelProfile[] = snapshot?.settings?.profiles ?? [];
  const writer = snapshot?.settings?.routes?.writer?.primary;
  const initial = profiles.find(p => p.profile_id === writer) ?? profiles.find(p => p.has_key) ?? profiles[0];
  const [provider, setProvider] = React.useState(initial?.provider ?? "");
  const profile = profiles.find(p => p.provider === provider);
  const [model, setModel] = React.useState(profile?.model_id ?? "");
  const [key, setKey] = React.useState("");
  const [step, setStep] = React.useState<Step | null>(null);
  const [done, setDone] = React.useState<Step[]>([]);
  const [error, setError] = React.useState<unknown>(null);
  const active = React.useRef(true);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  React.useEffect(() => { if (!provider && initial) { setProvider(initial.provider); setModel(initial.model_id); } }, [initial, provider]);
  const dirty = Boolean(key) || Boolean(profile && model.trim() !== profile.model_id);
  const guard = useSettingsDraft("quick", "快速设置", dirty, step !== null, () => { setKey(""); setModel(profile?.model_id ?? ""); setError(null); });
  const current = () => active.current && accountStore.get() === account;
  const readiness = writingReadiness(snapshot?.settings);
  const ready = readiness === "ready" && profile?.profile_id === writer && profile?.status === "verified";

  const run = async () => {
    if (!profile || step) return;
    const modelId = model.trim();
    if (!modelId || modelId.length > 160) { setError("请输入 1–160 字的模型 ID"); return; }
    if (!key.trim() && !profile.has_key) { setError("请粘贴这个供应商的 API Key"); return; }
    guard.processing(); setError(null); setDone([]);
    const mark = (value: Step) => { if (current()) setDone(previous => [...previous, value]); };
    try {
      setStep("key");
      if (key.trim()) {
        if (!window.ice?.saveKey) throw Error("当前环境不支持保存 Key");
        await window.ice.saveKey(profile.provider, key.trim());
        if (current()) setKey("");
      }
      mark("key");
      setStep("model");
      if (modelId !== profile.model_id) {
        await rpc("models.save", { provider: profile.provider, model_id: modelId, expected_model_id: profile.model_id, account_id: account });
      }
      mark("model");
      setStep("routes");
      const fresh = await rpc<BootstrapSettings>("bootstrap");
      if (fresh.account?.id !== account) throw Error("公众号已变化，请重新打开设置");
      const routes = textRoutes(fresh.settings?.routes);
      const next = assignPrimary(routes, profile.profile_id);
      if (JSON.stringify(next) !== JSON.stringify(routes)) {
        const saved = await rpc<BootstrapSettings>("models.routes_save", { account_id: account, routes_hash: fresh.routes_hash, routes: next });
        queryClient.setQueryData(["ice", account, "bootstrap", {}], saved);
      }
      mark("routes");
      setStep("probe");
      const result = await rpc<{ model: string }>("models.probe", { provider: profile.provider });
      mark("probe");
      if (current()) toast.success({ title: "模型已可用", detail: `${providers[profile.provider]?.name ?? profile.provider} · ${result.model}，已负责全部文字环节。` });
    } catch (problem) {
      if (current()) setError(problem);
    } finally {
      if (current()) setStep(null);
      await queryClient.invalidateQueries({ queryKey: ["ice", account, "bootstrap"] });
      await onDone();
    }
  };

  if (!profiles.length) return null;
  return (
    <section className="ice-quick-model" aria-label="快速设置模型" aria-busy={step !== null}>
      <div className="ice-model-routes__heading">
        <div>
          <h3 data-quick-heading tabIndex={-1}>快速设置：一个模型负责全部文字</h3>
          <p>选一个供应商，粘贴 Key，点“保存并测试”。之后助手对话、AI 起草、文章内改写都用这个模型。需要多个供应商或分角色配置时，展开下面的“高级设置”。</p>
        </div>
        <span className={"ice-badge" + (ready ? " ice-badge--success" : readiness === "untested" ? " ice-badge--warning" : "")}>
          {ready ? "已可用" : readiness === "untested" ? "未测试" : readiness === "unrouted" ? "未接入文字环节" : "未配置"}</span>
      </div>
      <fieldset disabled={step !== null} className="ice-quick-model__fields">
        <label><span>供应商</span>
          <select aria-label="供应商" value={provider} onChange={event => {
            const next = profiles.find(p => p.provider === event.target.value);
            setProvider(event.target.value); setModel(next?.model_id ?? ""); setKey(""); setError(null); setDone([]);
          }}>
            {profiles.map(p => <option key={p.provider} value={p.provider}>
              {(providers[p.provider]?.name ?? p.provider) + (providers[p.provider]?.service ? ` · ${providers[p.provider].service}` : "") + (p.has_key ? "（已有 Key）" : "")}</option>)}
          </select></label>
        <label><span>模型 ID</span>
          <Input value={model} maxLength={160} aria-label="模型 ID" onChange={event => { guard.changed(); setModel(event.target.value); }} /></label>
        <label className="ice-quick-model__key"><span>API Key</span>
          <Input type="password" autoComplete="off" value={key} aria-label="API Key"
                 placeholder={profile?.has_key ? "已配置 · 留空沿用原 Key" : "粘贴供应商控制台里的 Key"}
                 onChange={event => { guard.changed(); setKey(event.target.value); }}
                 onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void run(); } }} /></label>
      </fieldset>
      <div className="ice-quick-model__actions">
        <ol className="ice-quick-model__steps" aria-label="进度">
          {STEPS.map(item => <li key={item.id} className={done.includes(item.id) ? "is-done" : step === item.id ? "is-active" : ""}>
            {done.includes(item.id) ? "✓ " : ""}{item.label}</li>)}
        </ol>
        <Button variant="primary" loading={step !== null} disabled={!profile} onClick={() => void run()}
                title="测试连接会发送一次短请求，可能产生少量费用">保存并测试</Button>
      </div>
      <small className="ice-quick-model__note">Key 由系统加密保存，不会写进文章或导出包。测试连接会发送一次真实请求并计数。</small>
      {error != null && <ErrorNote error={error} note={done.length ? "前面打勾的步骤已经保存；修正后再点一次即可，从未完成的步骤继续。" : "本次没有保存任何修改。"} />}
    </section>
  );
}
