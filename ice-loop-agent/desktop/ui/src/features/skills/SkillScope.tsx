// v3.16/v3.17 写作技能的作用域选择：主技能 + 辅助技能；“本篇/本会话 → 系列 → 公众号”。
// 文章编辑器、AI 起草与助手会话共用。技能只影响写作与检查，不授予任何权限。
import * as React from "react";

import { Banner, Button, Dialog, Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery, useCurrentAccount } from "../../data/client";
import { skillSettingsStore } from "../../app/uiState";
import "../../styles/skillscope.css";

// v3.20 指令文字冲突（规则检查结果）
export type ConflictItem = { skill_id: string; skill_name: string; quote: string; pole: string; pole_label: string };
export type TextConflict = { kind: 'text' | 'rule'; dimension: string; label: string; items: ConflictItem[]; advice: string };

/** 冲突列表（规则检查结果），设置页与“本篇/本会话技能”预览共用。 */
export function ConflictList({ conflicts }: { conflicts: TextConflict[] }) {
  if (!conflicts.length) return null;
  return <ul className="ice-skills__conflicts">{conflicts.map((c, i) => <li key={c.dimension + i}>
    <strong>{c.label}</strong>{c.kind === 'rule' ? '（指令与检查规则）' : ''}：
    {c.items.map((item, j) => <span key={j} className="ice-skills__conflict-item">「{item.skill_name}」{item.pole_label} — <q>{item.quote}</q></span>)}
    <small>{c.advice}</small>
  </li>)}</ul>;
}

export type SkillBinding = { main?: string | null; addons?: string[] };
type SkillRow = { id: string; name: string; version: number; kind?: "main" | "addon" };
type SkillState = { skills: SkillRow[]; active_skill_id: string | null; active_addon_ids?: string[] };
type Brief = { id: string; name: string; version?: number | null; kind: "main" | "addon" };
type Scope = "document" | "series" | "account";
export type SkillPreview = { main: Brief | null; addons: Brief[]; scope: { main: Scope; addons: Scope }; rule_count: number;
  conflicts: Array<{ rule: string; kept_name: string; ignored_name: string; kind: "main" | "addon" }>; notices: string[];
  series?: string | null; binding?: SkillBinding | null; context?: "document" | "conversation" | "preview";
  text_conflicts?: TextConflict[] };

const SCOPE: Record<Scope, string> = { document: "本篇设置", series: "系列设置", account: "公众号默认" };
const scopeLabel = (scope: Scope, preview: SkillPreview) => scope === "document" && preview.context === "conversation" ? "本会话设置" : SCOPE[scope];
const MAX_ADDONS = 5;
const INHERIT = "";
const NONE = "__none__";

export const skillLine = (preview?: SkillPreview | null) => !preview ? "写作技能"
  : `${preview.main ? preview.main.name : "不使用主技能"}${preview.addons.length ? ` + ${preview.addons.map(a => a.name).join("、")}` : ""}`;

/** 选择器：主技能（沿用 / 不使用 / 某个主技能）+ 辅助技能（沿用 / 自选最多 5 个）。value 为 null 表示全部沿用。 */
export function SkillPicker({ value, onChange, inheritLabel, disabled }: {
  value: SkillBinding | null; onChange: (next: SkillBinding | null) => void; inheritLabel: string; disabled?: boolean;
}) {
  const state = useAccountQuery<SkillState>("skills.get", {}, { staleTime: 10_000 });
  const skills = state.data?.skills ?? [];
  const mains = skills.filter(s => (s.kind ?? "main") === "main"), addons = skills.filter(s => s.kind === "addon");
  const binding = value ?? {};
  const set = (next: SkillBinding) => onChange(Object.keys(next).length ? next : null);
  const mainValue = !("main" in binding) ? INHERIT : binding.main === null ? NONE : binding.main ?? INHERIT;
  const customAddons = "addons" in binding;
  if (state.isLoading) return <span className="ice-skillscope__muted"><Spinner size={12} /> 正在读取技能…</span>;
  if (state.error) return <span className="ice-skillscope__muted">技能列表读取失败：{state.error.message}</span>;
  return (
    <fieldset className="ice-skillscope__pick" disabled={disabled}>
      <label>主技能
        <select value={mainValue} aria-label="主技能" onChange={event => {
          const { main: _drop, ...rest } = binding; void _drop;
          const v = event.target.value;
          set(v === INHERIT ? rest : { ...rest, main: v === NONE ? null : v });
        }}>
          <option value={INHERIT}>{inheritLabel}</option>
          <option value={NONE}>不使用主技能</option>
          {mains.map(s => <option key={s.id} value={s.id}>{s.name} · v{s.version}</option>)}
        </select>
      </label>
      {addons.length > 0 && <div className="ice-skillscope__addons" role="group" aria-label="辅助技能">
        <label className="ice-skillscope__check"><input type="checkbox" aria-label={`辅助技能：${inheritLabel}`} checked={!customAddons} onChange={event => {
          const { addons: _drop, ...rest } = binding; void _drop;
          set(event.target.checked ? rest : { ...rest, addons: [] });
        }} />辅助技能：{inheritLabel}</label>
        {customAddons && addons.map(s => {
          const on = binding.addons!.includes(s.id);
          return <label key={s.id} className="ice-skillscope__check">
            <input type="checkbox" aria-label={`${s.name} v${s.version}`} checked={on} disabled={!on && binding.addons!.length >= MAX_ADDONS}
                   onChange={() => set({ ...binding, addons: on ? binding.addons!.filter(a => a !== s.id) : [...binding.addons!, s.id] })} />
            {s.name} <span className="ice-skillscope__muted">v{s.version}</span></label>;
        })}
      </div>}
      {addons.length === 0 && <span className="ice-skillscope__muted">还没有辅助技能；可在“写作技能”设置里把技能类型设为“辅助技能”。</span>}
    </fieldset>
  );
}

export function PreviewLines({ preview }: { preview: SkillPreview }) {
  return <div className="ice-skillscope__prev">
    <div>主技能：<strong>{preview.main ? `${preview.main.name} v${preview.main.version}` : "不使用"}</strong>
      <span className="ice-skillscope__muted"> · 来自{scopeLabel(preview.scope.main, preview)}{preview.scope.main === "series" && preview.series ? `「${preview.series}」` : ""}</span></div>
    <div>辅助技能：<strong>{preview.addons.length ? preview.addons.map(a => `${a.name} v${a.version}`).join("、") : "无"}</strong>
      <span className="ice-skillscope__muted"> · 来自{scopeLabel(preview.scope.addons, preview)}{preview.scope.addons === "series" && preview.series ? `「${preview.series}」` : ""}</span></div>
    <div className="ice-skillscope__muted">生效检查规则 {preview.rule_count} 项</div>
    {preview.conflicts.length > 0 && <ul className="ice-skillscope__warn">{preview.conflicts.map(c => <li key={c.rule + c.ignored_name}>
      检查规则 {c.rule}：按「{c.kept_name}」，忽略「{c.ignored_name}」的不同要求{c.kind === "main" ? "（主技能优先）" : ""}</li>)}</ul>}
    {preview.notices.map(n => <p key={n} className="ice-skillscope__muted">{n}</p>)}
    {(preview.text_conflicts?.length ?? 0) > 0 && <div className="ice-skillscope__warn-block">
      <span>指令可能冲突（生成时模型只能二选一，建议在“写作技能”里统一说法）：</span>
      <ConflictList conflicts={preview.text_conflicts!} /></div>}
  </div>;
}

export type GeneratedSkill = { name: string; version?: number | null; kind: string };

/** 技能标签 + 对话框：文章（本篇）与助手会话共用。按“本篇/本会话 → 系列 → 公众号”生效。 */
export function SkillScopeChip({ target, saveMethod, binding, generated, noun, effect }: {
  target: { document_id: string } | { conversation_id: string };
  saveMethod: "documents.skill_binding" | "skills.conversation_binding";
  binding: SkillBinding | null; generated?: GeneratedSkill[];
  noun: "本篇" | "本会话"; effect: string;
}) {
  const account = useCurrentAccount();
  const current = useAccountQuery<SkillPreview>("skills.resolve", target, { staleTime: 30_000, retry: false });
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<SkillBinding | null>(binding);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) setDraft(current.data ? current.data.binding ?? null : binding); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useAccountQuery<SkillPreview>("skills.resolve", { ...target, binding: draft }, { enabled: open, staleTime: 0, retry: false });
  const save = async (next: SkillBinding | null) => {
    setBusy(true);
    try {
      const result = await rpc<SkillPreview>(saveMethod, { account_id: account, ...target, binding: next });
      if (accountStore.get() !== account) return;
      queryClient.setQueryData(["ice", account, "skills.resolve", target], result);
      if ("document_id" in target) void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.get"] });
      setOpen(false);
      toast.success({ title: next ? `已设置${noun}技能` : "已恢复沿用默认技能", detail: `${noun}使用：${skillLine(result)}。${effect}` });
    } catch (error) { toast.error({ title: `没有保存${noun}技能`, detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const label = current.data ? skillLine(current.data) : "写作技能";
  const own = current.data?.scope.main === "document" || current.data?.scope.addons === "document";
  return <>
    <button type="button" className={"ice-skillscope__chip" + (own ? " is-own" : "")}
            title={current.data ? `${noun}使用：${label}（主技能来自${scopeLabel(current.data.scope.main, current.data)}）` : `${noun}使用的写作技能`}
            onClick={() => setOpen(true)} aria-label={`${noun}技能：${label}`}>✎ {label}</button>
    <Dialog open={open} onOpenChange={value => { if (!value && !busy) setOpen(false); }} title={`${noun}写作技能`} width={560}
      description={`按“${noun} → 系列 → 公众号”生效。${effect}已生成的内容、进行中的任务和重试保留原技能。`}
      footer={<>
        <Button variant="ghost" onClick={() => { setOpen(false); skillSettingsStore.set(true); }}>管理技能</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setOpen(false)} disabled={busy}>取消</Button>
        {(current.data ? current.data.binding : binding) && <Button disabled={busy} onClick={() => void save(null)}>恢复沿用默认</Button>}
        <Button variant="primary" loading={busy} onClick={() => void save(draft)}>保存{noun}设置</Button>
      </>}>
      <div className="ice-skillscope__form">
        {generated && generated.length > 0 && <p className="ice-skillscope__muted">生成初稿时使用：{generated.map(g => `${g.name}${g.version ? ` v${g.version}` : ""}`).join(" + ")}</p>}
        <SkillPicker value={draft} onChange={setDraft} inheritLabel="沿用系列 / 公众号设置" disabled={busy} />
        {preview.data ? <PreviewLines preview={preview.data} />
          : preview.error ? <Banner tone="warning" title="无法预览">{preview.error.message}</Banner>
          : <span className="ice-skillscope__muted"><Spinner size={12} /> 正在计算生效技能…</span>}
      </div>
    </Dialog>
  </>;
}
