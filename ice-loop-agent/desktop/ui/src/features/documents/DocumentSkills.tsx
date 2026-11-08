// v3.16 本篇写作技能：主技能 + 辅助技能，按“本篇 → 系列 → 公众号”解析。
// 编辑器顶栏显示“本篇使用”，可改为本篇专用；AI 起草时也可先选。技能只影响写作与检查，不授予任何权限。
import * as React from "react";

import { Banner, Button, Dialog, Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { skillSettingsStore } from "../../app/uiState";
import { docRpc } from "./documentsApi";

export type SkillBinding = { main?: string | null; addons?: string[] };
type SkillRow = { id: string; name: string; version: number; kind?: "main" | "addon" };
type SkillState = { skills: SkillRow[]; active_skill_id: string | null; active_addon_ids?: string[] };
type Brief = { id: string; name: string; version?: number | null; kind: "main" | "addon" };
type Scope = "document" | "series" | "account";
export type SkillPreview = { main: Brief | null; addons: Brief[]; scope: { main: Scope; addons: Scope }; rule_count: number;
  conflicts: Array<{ rule: string; kept_name: string; ignored_name: string; kind: "main" | "addon" }>; notices: string[];
  series?: string | null; binding?: SkillBinding | null };

const SCOPE: Record<Scope, string> = { document: "本篇设置", series: "系列设置", account: "公众号默认" };
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
  if (state.isLoading) return <span className="ice-doc-muted"><Spinner size={12} /> 正在读取技能…</span>;
  if (state.error) return <span className="ice-doc-muted">技能列表读取失败：{state.error.message}</span>;
  return (
    <fieldset className="ice-doc-skillpick" disabled={disabled}>
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
      {addons.length > 0 && <div className="ice-doc-skillpick__addons" role="group" aria-label="辅助技能">
        <label className="ice-doc-check"><input type="checkbox" checked={!customAddons} onChange={event => {
          const { addons: _drop, ...rest } = binding; void _drop;
          set(event.target.checked ? rest : { ...rest, addons: [] });
        }} />辅助技能：{inheritLabel}</label>
        {customAddons && addons.map(s => {
          const on = binding.addons!.includes(s.id);
          return <label key={s.id} className="ice-doc-check">
            <input type="checkbox" checked={on} disabled={!on && binding.addons!.length >= MAX_ADDONS}
                   onChange={() => set({ ...binding, addons: on ? binding.addons!.filter(a => a !== s.id) : [...binding.addons!, s.id] })} />
            {s.name} <span className="ice-doc-muted">v{s.version}</span></label>;
        })}
      </div>}
      {addons.length === 0 && <span className="ice-doc-muted">还没有辅助技能；可在“写作技能”设置里把技能类型设为“辅助技能”。</span>}
    </fieldset>
  );
}

function PreviewLines({ preview }: { preview: SkillPreview }) {
  return <div className="ice-doc-skillprev">
    <div>主技能：<strong>{preview.main ? `${preview.main.name} v${preview.main.version}` : "不使用"}</strong>
      <span className="ice-doc-muted"> · 来自{SCOPE[preview.scope.main]}{preview.scope.main === "series" && preview.series ? `「${preview.series}」` : ""}</span></div>
    <div>辅助技能：<strong>{preview.addons.length ? preview.addons.map(a => `${a.name} v${a.version}`).join("、") : "无"}</strong>
      <span className="ice-doc-muted"> · 来自{SCOPE[preview.scope.addons]}{preview.scope.addons === "series" && preview.series ? `「${preview.series}」` : ""}</span></div>
    <div className="ice-doc-muted">生效检查规则 {preview.rule_count} 项</div>
    {preview.conflicts.length > 0 && <ul className="ice-doc-skillprev__warn">{preview.conflicts.map(c => <li key={c.rule + c.ignored_name}>
      检查规则 {c.rule}：按「{c.kept_name}」，忽略「{c.ignored_name}」的不同要求{c.kind === "main" ? "（主技能优先）" : ""}</li>)}</ul>}
    {preview.notices.map(n => <p key={n} className="ice-doc-muted">{n}</p>)}
  </div>;
}

/** 编辑器顶栏：本篇使用的技能。点开可改为本篇专用，或恢复沿用系列/公众号设置。 */
export function DocumentSkillChip({ documentId, binding, generated }: {
  documentId: string; binding: SkillBinding | null; generated?: Array<{ name: string; version?: number | null; kind: string }>;
}) {
  const account = useCurrentAccount();
  const key = { document_id: documentId };
  const current = useAccountQuery<SkillPreview>("skills.resolve", key, { staleTime: 30_000, retry: false });
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<SkillBinding | null>(binding);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) setDraft(current.data?.binding ?? binding); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useAccountQuery<SkillPreview>("skills.resolve", { ...key, binding: draft }, { enabled: open, staleTime: 0, retry: false });
  const save = async (next: SkillBinding | null) => {
    setBusy(true);
    try {
      const result = await docRpc<SkillPreview>("documents.skill_binding", { account_id: account, document_id: documentId, binding: next });
      queryClient.setQueryData(["ice", account, "skills.resolve", key], result);
      void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.get"] });
      setOpen(false);
      toast.success({ title: next ? "已设置本篇技能" : "已恢复沿用默认技能", detail: `本篇使用：${skillLine(result)}。之后的 AI 助手按此生效。` });
    } catch (error) { toast.error({ title: "没有保存本篇技能", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const label = current.data ? skillLine(current.data) : "写作技能";
  return <>
    <button type="button" className={"ice-doc-chip ice-doc-skillchip" + (current.data?.scope.main === "document" || current.data?.scope.addons === "document" ? " is-busy" : "")}
            title={current.data ? `本篇使用：${label}（主技能来自${SCOPE[current.data.scope.main]}）` : "本篇使用的写作技能"}
            onClick={() => setOpen(true)} aria-label={`本篇技能：${label}`}>✎ {label}</button>
    <Dialog open={open} onOpenChange={value => { if (!value && !busy) setOpen(false); }} title="本篇写作技能" width={560}
      description="按“本篇 → 系列 → 公众号”生效。改动影响之后的 AI 助手与新的生成，已生成的内容和进行中的任务不变。"
      footer={<>
        <Button variant="ghost" onClick={() => { setOpen(false); skillSettingsStore.set(true); }}>管理技能</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setOpen(false)} disabled={busy}>取消</Button>
        {(current.data ? current.data.binding : binding) && <Button disabled={busy} onClick={() => void save(null)}>恢复沿用默认</Button>}
        <Button variant="primary" loading={busy} onClick={() => void save(draft)}>保存本篇设置</Button>
      </>}>
      <div className="ice-doc-form">
        {generated && generated.length > 0 && <p className="ice-doc-muted">生成初稿时使用：{generated.map(g => `${g.name}${g.version ? ` v${g.version}` : ""}`).join(" + ")}</p>}
        <SkillPicker value={draft} onChange={setDraft} inheritLabel="沿用系列 / 公众号设置" disabled={busy} />
        {preview.data ? <PreviewLines preview={preview.data} />
          : preview.error ? <Banner tone="warning" title="无法预览">{preview.error.message}</Banner>
          : <span className="ice-doc-muted"><Spinner size={12} /> 正在计算生效技能…</span>}
      </div>
    </Dialog>
  </>;
}
