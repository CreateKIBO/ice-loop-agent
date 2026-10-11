// 模型与 Key（新工作台内的最小可用设置）：新装用户不用切回经典界面就能开始写。
// 角色分工、请求预算等高级项仍在经典界面，这里给出入口。
import * as React from "react";
import { motion, useAnimationControls } from "motion/react";

import { Button, Dialog, Input, SkeletonRows } from "../components/ui";
import { toast } from "../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery, useCurrentConversation, type RpcError } from "../data/client";
import { switchToClassic } from "../data/desktop";
import { settingsStore } from "./uiState";

export type ModelProfile = {
  provider: string; profile_id: string; model_id: string; base_url: string;
  status: string; has_key: boolean;
};
export type BootstrapSettings = {
  version?: string;
  account?: { id: string; name: string };
  credential_warning?: string | null;
  settings?: { profiles: ModelProfile[]; routes?: Record<string, { primary?: string }> };
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

/** 至少一个供应商配了 Key 才能生成；verified 表示测试连接通过过。 */
export function useModelReadiness(): "unknown" | "missing" | "untested" | "ready" {
  const boot = useBootstrap();
  const profiles = boot.data?.settings?.profiles;
  if (!profiles) return "unknown";
  if (profiles.some(profile => profile.has_key && profile.status === "verified")) return "ready";
  if (profiles.some(profile => profile.has_key)) return "untested";
  return "missing";
}

const refreshBootstrap = () =>
  queryClient.invalidateQueries({ queryKey: ["ice", accountStore.get(), "bootstrap"] });

export function ModelSettings() {
  const open = settingsStore.use();
  const boot = useAccountQuery<BootstrapSettings>("bootstrap", {}, { enabled: open, staleTime: 0 });
  const profiles = boot.data?.settings?.profiles ?? [];
  const writer = boot.data?.settings?.routes?.writer?.primary;

  return (
    <Dialog open={open} onOpenChange={settingsStore.set} title="模型与 Key" width={760} initialFocus="input[type=password]"
            description="至少给一个供应商保存 Key 并测试连接，才能生成内容。Key 由系统加密保存，正文和日志里不会出现。"
            footer={<>
              <span style={{ flex: 1, color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
                角色分工与思考策略在经典界面设置。
              </span>
              <Button variant="ghost" onClick={() => { settingsStore.set(false); void switchToClassic(); }}>
                去经典界面
              </Button>
              <Button variant="primary" onClick={() => settingsStore.set(false)}>完成</Button>
            </>}>
      {boot.isLoading && <SkeletonRows rows={6} height={18} />}
      {boot.error && (
        <div role="alert" className="ice-error-text">
          读取设置失败：{(boot.error as RpcError).message}
          <button type="button" className="ice-link-btn" style={{ marginLeft: 8 }} onClick={() => boot.refetch()}>重试</button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))", gap: "var(--ice-space-3)" }}>
        {profiles.map((profile, index) => (
          <motion.div key={profile.provider} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ minWidth: 0 }}
                      transition={{ delay: index * 0.04, duration: 0.2 }}>
            <ProviderCard profile={profile} usedForWriting={writer === profile.profile_id} />
          </motion.div>
        ))}
      </div>
      <BudgetPanel />
    </Dialog>
  );
}

type BudgetView = {
  max_model_calls: number; max_image_model_calls: number;
  max_chat_calls: number; chat_unlimited: boolean; chat_configured: boolean;
  conversation?: { limit: number; unlimited: boolean; used: number; remaining: number | null };
};

/** C3：预算只展示与保存，计数由后端账本执行。0 是显式不限制，未配置则按默认 24。 */
function BudgetPanel() {
  const conversationId = useCurrentConversation();
  const budget = useAccountQuery<BudgetView>("budgets.get",
    conversationId ? { conversation_id: conversationId } : {}, { staleTime: 0 });
  const [chatLimit, setChatLimit] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (budget.data) setChatLimit(String(budget.data.max_chat_calls));
  }, [budget.data]);

  const save = async () => {
    if (!budget.data || busy) return;
    const next = Number(chatLimit);
    if (!Number.isInteger(next) || next < 0 || next > 1000) {
      setError("会话上限需为 0–1000 的整数，0 表示不限制");
      return;
    }
    setBusy(true); setError(null);
    try {
      await rpc("budgets.save", {
        scope: "defaults", max_model_calls: budget.data.max_model_calls,
        max_image_model_calls: budget.data.max_image_model_calls, max_chat_calls: next,
      });
      await queryClient.invalidateQueries({ queryKey: ["ice", accountStore.get(), "budgets.get"] });
      toast.success({ title: "预算已保存", detail: next === 0 ? "会话模型调用不再限制" : `每个会话最多 ${next} 次模型调用` });
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(false); }
  };

  const data = budget.data;
  const conversation = data?.conversation;
  return (
    <section aria-label="模型调用预算" style={{ marginTop: "var(--ice-space-4)", display: "grid", gap: 8,
                                            borderTop: "1px solid var(--ice-border)", paddingTop: "var(--ice-space-3)" }}>
      <strong>模型调用预算</strong>
      <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", lineHeight: 1.6 }}>
        计数以引擎账本为准：每次真实模型请求记一次，失败重试也计入；能力不匹配的探测不计入。界面只展示，不能代替账本扣减。
      </div>
      {budget.error && <div role="alert" className="ice-error-text">预算读取失败：{(budget.error as RpcError).message}</div>}
      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
          <BudgetStat label="全局默认 · 普通文章" value={`${data.max_model_calls} 次/篇`} />
          <BudgetStat label="全局默认 · 补图任务" value={`${data.max_image_model_calls} 次/篇`} />
          <BudgetStat label="会话上限" value={data.chat_unlimited ? "不限制" : `${data.max_chat_calls} 次/会话`}
                      hint={data.chat_configured ? undefined : "未单独配置，按默认 24"} />
          {conversation && (
            <BudgetStat label="当前会话" tone={conversation.remaining === 0 ? "danger" : undefined}
                        value={conversation.unlimited ? `已用 ${conversation.used} 次` : `已用 ${conversation.used} / 剩余 ${conversation.remaining}`} />
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "var(--ice-font-size-sm)" }}>
          会话调用上限
          <Input type="number" min={0} max={1000} value={chatLimit} style={{ width: 90 }}
                 aria-label="会话模型调用上限" onChange={event => setChatLimit(event.target.value)} />
        </label>
        <Button loading={busy} disabled={!data || busy} onClick={save}>保存预算</Button>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
          0 表示不限制；单篇上限在经典界面按文章调整。
        </span>
      </div>
      {error && <div role="alert" className="ice-error-text">{error}</div>}
    </section>
  );
}

function BudgetStat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="ice-card ice-card--compact" style={{ gap: 2, padding: "8px 10px" }}>
      <div style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>{label}</div>
      <div style={{ fontWeight: 600, color: tone === "danger" ? "var(--ice-danger)" : "var(--ice-text)" }}>{value}</div>
      {hint && <div style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>{hint}</div>}
    </div>
  );
}

function ProviderCard({ profile, usedForWriting }: { profile: ModelProfile; usedForWriting: boolean }) {
  const meta = PROVIDERS[profile.provider] ?? { mark: profile.provider.slice(0, 1).toUpperCase(), name: profile.provider, service: "" };
  const [modelId, setModelId] = React.useState(profile.model_id);
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState<"key" | "probe" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const shake = useAnimationControls();
  React.useEffect(() => setModelId(profile.model_id), [profile.model_id]);

  const fail = (message: string) => {
    setError(message);
    void shake.start({ x: [0, -6, 6, -4, 4, 0], transition: { duration: 0.32 } });
  };

  const saveKey = async () => {
    if (!key.trim() || busy) return;
    if (!window.ice?.saveKey) { fail("当前环境不支持保存 Key"); return; }
    setBusy("key"); setError(null);
    try {
      await window.ice.saveKey(profile.provider, key.trim());
      setKey("");
      toast.success({ title: `${meta.name} Key 已加密保存`, detail: "建议点「测试连接」确认可用" });
      await refreshBootstrap();
    } catch (err) { fail((err as Error).message); }
    finally { setBusy(null); }
  };

  const probe = async () => {
    if (busy) return;
    setBusy("probe"); setError(null);
    try {
      if (modelId.trim() !== profile.model_id) {
        await rpc("models.save", { provider: profile.provider, model_id: modelId.trim() });
      }
      const result = await rpc<{ model: string }>("models.probe", { provider: profile.provider });
      toast.success({ title: `${meta.name} 连接通过`, detail: "实际模型：" + result.model });
      await refreshBootstrap();
    } catch (err) { fail((err as Error).message); }
    finally { setBusy(null); }
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
        {usedForWriting && <span className="ice-badge ice-badge--info" title="经典界面「角色分工」中设为正文写作主模型">正文使用</span>}
        <span className={"ice-badge" + (status.tone ? " ice-badge--" + status.tone : "")}>{status.label}</span>
      </div>
      <label style={{ display: "grid", gap: 4, fontSize: "var(--ice-font-size-sm)" }}>
        模型 ID
        <Input value={modelId} onChange={event => setModelId(event.target.value)} aria-label={meta.name + " 模型 ID"} />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: "var(--ice-font-size-sm)" }}>
        API Key
        <div style={{ display: "flex", gap: 6 }}>
          <Input type="password" autoComplete="off" value={key} style={{ flex: 1, minWidth: 0 }}
                 onChange={event => setKey(event.target.value)}
                 onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveKey(); } }}
                 placeholder={profile.has_key ? "已配置 · 留空保持原 Key" : "粘贴供应商控制台的 Key"}
                 aria-label={meta.name + " API Key"} />
          <Button loading={busy === "key"} disabled={!key.trim() || busy !== null} onClick={saveKey}>保存 Key</Button>
        </div>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant={profile.has_key && profile.status !== "verified" ? "primary" : "secondary"}
                loading={busy === "probe"} disabled={!profile.has_key || busy !== null || !modelId.trim()}
                title={profile.has_key ? "发送一次短请求验证 Key 和模型 ID，可能产生少量费用" : "先保存 Key"}
                onClick={probe}>测试连接</Button>
        <span style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)", overflow: "hidden",
                       textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={profile.base_url}>
          {profile.base_url}
        </span>
      </div>
      {error && <div role="alert" className="ice-error-text">{error}</div>}
    </motion.section>
  );
}
