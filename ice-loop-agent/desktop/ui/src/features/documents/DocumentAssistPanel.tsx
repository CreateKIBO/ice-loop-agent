// v3 P1-01 文章内助手：选中段落 → 改写/扩写/压缩/改语气/图位建议 → 提案 → 勾选采纳（部分采纳）→ 一步撤销。
// 提案只在服务端落库，不直接改正文；采纳时服务端按块 id + 原文校验，原文变化的修改标为“已过期”，仍可查看。
import * as React from "react";

import { Button, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { inlineDiff, type DiffPart } from "../editor/inlineDiff";
import {
  ASSIST_ACTIONS, ASSIST_TONES, docRpc, formatTime,
  type AssistAction, type AssistApplied, type Proposal, type ProposalOp,
} from "./documentsApi";

/** 编辑器提供给助手的最小接口：只读选区/块文字，采纳结果以单个事务载入（Ctrl+Z 一步撤销）。 */
export type AssistBridge = {
  selection: () => string[];
  blockText: (id: string) => string | null;
  focusBlock: (id: string) => void;
  apply: (result: AssistApplied) => void;
  lock: (locked: boolean) => void;
  subscribe: (listener: () => void) => () => void;
};

const squash = (text: string) => text.replace(/\s+/g, "");
const STATUS: Record<Proposal["status"], string> = {
  generating: "生成中", ready: "待采纳", failed: "失败", cancelled: "已取消", applied: "已采纳",
  partially_applied: "部分采纳", rejected: "已放弃",
};

type Pinned = { document_id: string; title: string };
type SearchResult = { results: Array<{ document_id: string; title: string; series: string | null; episode: number | null;
  snippet: string; published: boolean; updated_at: string }>; series: string; series_count: number; total?: number };
const MAX_REFS = 3;
const pinKey = (id: string) => "ice.assist.refs." + id;
function readPins(id: string): Pinned[] {
  try { const value = JSON.parse(window.localStorage.getItem(pinKey(id)) ?? "[]"); return Array.isArray(value) ? value.slice(0, MAX_REFS) : []; }
  catch { return []; }
}
function writePins(id: string, pins: Pinned[]) {
  try { window.localStorage.setItem(pinKey(id), JSON.stringify(pins)); } catch { /* 仅为便利，失败不影响功能 */ }
}

export function DocumentAssistPanel({ documentId, bridge, flush, revision, series }: {
  documentId: string; bridge: AssistBridge; flush: () => Promise<void>; revision: () => number; series: string | null;
}) {
  const account = useCurrentAccount();
  const [action, setAction] = React.useState<AssistAction>("rewrite");
  const [tone, setTone] = React.useState(ASSIST_TONES[0]);
  const [instruction, setInstruction] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // P1-02：钉选本号旧稿与系列前情作为只读参考上下文。
  const [pins, setPins] = React.useState<Pinned[]>(() => readPins(documentId));
  const [withSeries, setWithSeries] = React.useState(false);
  const updatePins = (next: Pinned[]) => { setPins(next); writePins(documentId, next); };
  // 选区与正文变化时刷新“选中 N 段”和每处修改的过期状态。
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => bridge.subscribe(bump), [bridge]);
  const selected = bridge.selection();
  const list = useAccountQuery<Proposal[]>("documents.assist_list", { document_id: documentId }, {
    staleTime: 0,
    refetchInterval: query => ((query.state.data as Proposal[] | undefined) ?? []).some(p => p.status === "generating") ? 1500 : false,
  });
  const refresh = React.useCallback(() => queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.assist_list"] }), [account]);
  const wholeDoc = action === "image_slots";
  const meta = ASSIST_ACTIONS.find(item => item.value === action)!;

  const start = async (request: { action: AssistAction; block_ids: string[]; tone?: string; instruction?: string }) => {
    if (request.action !== "image_slots" && !request.block_ids.length) {
      toast.info({ title: "先在正文中选中要修改的段落", detail: "把光标放在某一段里也可以，只改这一段。" });
      return;
    }
    if (request.action === "custom" && (request.instruction ?? "").trim().length < 2) {
      toast.info({ title: "写下希望怎样修改", detail: "例如：加一个反问开头、换成第一人称、删掉口头禅。" });
      return;
    }
    setBusy(true);
    try {
      await flush();
      await docRpc<Proposal>("documents.assist_start", { document_id: documentId, base_revision: revision(), ...request,
        reference_ids: pins.map(pin => pin.document_id), series_context: Boolean(series && withSeries) });
      void refresh();
    } catch (error) { toast.error({ title: "助手没有开始", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const submit = () => void start({ action, block_ids: wholeDoc ? [] : selected, tone: action === "tone" ? tone : undefined,
                                    instruction: instruction.trim() || undefined });

  const proposals = list.data ?? [];
  const latestApplied = proposals.find(p => p.status === "applied" || p.status === "partially_applied")?.proposal_id;
  return (
    <div className="ice-doc-form ice-assist">
      <div className="ice-assist__actions" role="radiogroup" aria-label="助手操作">
        {ASSIST_ACTIONS.map(item => <button key={item.value} type="button" role="radio" aria-checked={action === item.value}
          className={"ice-assist__action" + (action === item.value ? " is-on" : "")} title={item.hint}
          onClick={() => setAction(item.value)}>{item.label}</button>)}
      </div>
      <div className="ice-assist__scope">
        {wholeDoc ? <span className="ice-doc-chip">范围：全文（只建议，不改正文）</span>
          : selected.length ? <button type="button" className="ice-doc-chip is-ok" onClick={() => bridge.focusBlock(selected[0])}>已选中 {selected.length} 段</button>
          : <span className="ice-doc-chip is-warn">未选中段落：在正文里选中或把光标放进某段</span>}
        <span className="ice-doc-chip" title="会附带前后各一段只读上下文、全文小标题、本号写作技能与文章规则">上下文：前后文 · 大纲 · 写作技能</span>
      </div>
      <References documentId={documentId} series={series} pins={pins} onPins={updatePins} withSeries={withSeries} onSeries={setWithSeries} />
      {action === "tone" && <label className="ice-assist__field">语气
        <select value={tone} onChange={event => setTone(event.target.value)} aria-label="目标语气">
          {ASSIST_TONES.map(value => <option key={value}>{value}</option>)}
        </select></label>}
      <textarea className="ice-assist__input" rows={action === "custom" ? 3 : 2} maxLength={500} value={instruction}
                placeholder={action === "custom" ? "希望怎样修改？例如：加一个反问开头，控制在 80 字内" : `补充要求（可选）· ${meta.hint}`}
                aria-label="修改要求"
                onChange={event => setInstruction(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
      <div className="ice-doc-row">
        <span className="ice-doc-muted">结果先作为提案列在下面，勾选后才会改正文。</span>
        <span style={{ flex: 1 }} />
        <Button variant="primary" size="sm" loading={busy} onClick={submit}>{meta.label}</Button>
      </div>

      {list.isLoading && <div className="ice-doc-muted"><Spinner size={12} /> 正在读取修改提案…</div>}
      {list.error && <ErrorNote error={list.error} onRetry={() => list.refetch()} retryLabel="重新读取提案" />}
      {!list.isLoading && !proposals.length && <p className="ice-doc-muted ice-assist__empty">
        还没有修改提案。改写会以段落为单位进行；加粗、链接会保留，文字颜色、字号等行内样式需要采纳后重新设置。</p>}
      <div className="ice-assist__list">
        {proposals.map(proposal => <ProposalCard key={proposal.proposal_id + ":" + proposal.status} proposal={proposal} bridge={bridge}
          flush={flush} revision={revision} refresh={refresh} canRevert={proposal.proposal_id === latestApplied}
          onRetry={() => void start({ action: proposal.action, block_ids: proposal.target_block_ids,
            tone: proposal.action === "tone" ? proposal.instruction : undefined,
            instruction: proposal.action !== "tone" && proposal.instruction ? proposal.instruction : undefined })} />)}
      </div>
    </div>
  );
}

function References({ documentId, series, pins, onPins, withSeries, onSeries }: {
  documentId: string; series: string | null; pins: Pinned[]; onPins: (pins: Pinned[]) => void;
  withSeries: boolean; onSeries: (value: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const found = useAccountQuery<SearchResult>("documents.assist_search", { document_id: documentId, query }, { enabled: open && query.length > 0 });
  const siblings = useAccountQuery<SearchResult>("documents.assist_search", { document_id: documentId, series_only: true }, { enabled: Boolean(series) });
  const seriesCount = siblings.data?.series_count ?? 0;
  const pinned = new Set(pins.map(pin => pin.document_id));
  const full = pins.length >= MAX_REFS;
  return (
    <div className="ice-assist__refs">
      <div className="ice-doc-row">
        <strong>参考</strong>
        <span className="ice-doc-muted">钉选本号旧稿（最多 {MAX_REFS} 篇），对齐文风、术语和前情；只读，不会照抄。</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ice-link-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起检索" : "检索旧稿"}</button>
      </div>
      {pins.length > 0 && <div className="ice-assist__scope">
        {pins.map(pin => <span key={pin.document_id} className="ice-doc-chip is-busy">📌 {pin.title.slice(0, 18)}
          <button type="button" className="ice-assist__unpin" aria-label={`取消钉选 ${pin.title}`}
                  onClick={() => onPins(pins.filter(item => item.document_id !== pin.document_id))}>×</button></span>)}
      </div>}
      {series && <label className="ice-assist__check">
        <input type="checkbox" checked={withSeries} disabled={!seriesCount} onChange={event => onSeries(event.target.checked)} />
        带上「{series}」系列前情{seriesCount ? `（最近 ${Math.min(seriesCount, 5)} 期标题与摘要）` : "（本系列还没有其他文章）"}
      </label>}
      {open && <>
        <input className="ice-assist__search" type="search" value={text} placeholder="在当前公众号的文章标题与正文中检索" aria-label="检索旧稿"
               maxLength={100} onChange={event => setText(event.target.value)} autoFocus />
        {found.isFetching && <div className="ice-doc-muted"><Spinner size={10} /> 检索中…</div>}
        {found.error && <ErrorNote error={found.error} onRetry={() => found.refetch()} retryLabel="重新检索" />}
        {query && found.data && !found.data.results.length && <div className="ice-doc-muted">没有找到包含「{query}」的文章。</div>}
        <ul className="ice-assist__results">
          {(found.data?.results ?? []).slice(0, 8).map(item => <li key={item.document_id}>
            <div className="ice-doc-row">
              <strong className="ice-assist__rtitle">{item.title}</strong>
              {item.series && <span className="ice-doc-chip">{item.series}{item.episode ? ` · 第${item.episode}期` : ""}</span>}
              {item.published && <span className="ice-doc-chip is-ok">已发布</span>}
              <span style={{ flex: 1 }} />
              <button type="button" className="ice-link-btn" disabled={pinned.has(item.document_id) || full}
                      onClick={() => onPins([...pins, { document_id: item.document_id, title: item.title }])}>
                {pinned.has(item.document_id) ? "已钉选" : full ? "已满 3 篇" : "钉选"}</button>
            </div>
            <div className="ice-doc-muted">{item.snippet}</div>
          </li>)}
        </ul>
        {(found.data?.total ?? 0) > 8 && <div className="ice-doc-muted">共 {found.data?.total} 篇，只显示最相关的 8 篇；可以换个更具体的词。</div>}
      </>}
    </div>
  );
}

function liveState(op: ProposalOp, bridge: AssistBridge): "ok" | "stale" {
  const live = bridge.blockText(op.block_id);
  if (live === null) return "stale";
  if (op.kind === "insert_after") return "ok";
  return squash(live) === squash(op.before_text) ? "ok" : "stale";
}

function ProposalCard({ proposal, bridge, flush, revision, refresh, canRevert, onRetry }: {
  proposal: Proposal; bridge: AssistBridge; flush: () => Promise<void>; revision: () => number;
  refresh: () => void; canRevert: boolean; onRetry: () => void;
}) {
  const decidable = proposal.status === "ready";
  const states = proposal.ops.map(op => decidable ? liveState(op, bridge) : op.state);
  const [checked, setChecked] = React.useState<Set<string>>(() =>
    new Set(proposal.ops.filter((_, index) => decidable && states[index] === "ok").map(op => op.op_id)));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(decidable || proposal.status === "generating");
  const usable = proposal.ops.filter((_, index) => states[index] === "ok");
  const chosen = usable.filter(op => checked.has(op.op_id)).map(op => op.op_id);

  const run = async (kind: string, task: () => Promise<void>) => {
    setBusy(kind);
    try { await task(); } catch (error) { toast.error({ title: "操作没有完成", detail: (error as Error).message }); }
    finally { setBusy(null); refresh(); }
  };
  const apply = (ids: string[]) => run("apply", async () => {
    await flush();
    bridge.lock(true);
    try {
      const result = await docRpc<AssistApplied>("documents.assist_apply", { proposal_id: proposal.proposal_id, op_ids: ids, base_revision: revision() });
      bridge.apply(result);
      const stale = result.stale?.length ?? 0;
      toast.success({ title: `已采纳 ${result.applied?.length ?? ids.length} 处修改`,
        detail: (stale ? `${stale} 处原文已变化，未套用。` : "") + "已另存为一个版本；Ctrl+Z 或“撤销本次采纳”可一步回退。" });
    } finally { bridge.lock(false); }
  });
  const revert = () => run("revert", async () => {
    await flush();
    bridge.lock(true);
    try {
      bridge.apply(await docRpc<AssistApplied>("documents.assist_revert", { proposal_id: proposal.proposal_id, base_revision: revision() }));
      toast.success({ title: "已撤销本次采纳", detail: "正文回到采纳前；这条提案可以重新勾选采纳。" });
    } finally { bridge.lock(false); }
  });
  const dismiss = () => run("dismiss", async () => { await docRpc("documents.assist_dismiss", { proposal_id: proposal.proposal_id }); });
  const cancel = () => run("cancel", async () => { await docRpc("documents.assist_cancel", { proposal_id: proposal.proposal_id }); });
  const toggle = (id: string) => setChecked(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const accepted = proposal.decision.accepted?.length ?? 0;
  const label = proposal.action_label + (proposal.action === "tone" && proposal.instruction ? `·${proposal.instruction}` : "");
  return (
    <section className={"ice-assist__card is-" + proposal.status} aria-label={`${label}提案`}>
      <header className="ice-doc-row">
        <button type="button" className="ice-assist__title" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <strong>{label}</strong>
          <span className="ice-doc-muted">{proposal.action === "image_slots" ? "全文" : `${proposal.context.targets} 段`} · {formatTime(proposal.created_at)}</span>
        </button>
        <span style={{ flex: 1 }} />
        <span className={"ice-assist__status is-" + proposal.status}>
          {proposal.status === "generating" && <Spinner size={10} />}
          {STATUS[proposal.status]}{(proposal.status === "applied" || proposal.status === "partially_applied") && ` ${accepted}/${proposal.ops.length}`}
        </span>
      </header>
      {proposal.action === "custom" && proposal.instruction && <div className="ice-doc-muted">要求：{proposal.instruction}</div>}
      {((proposal.context.references?.length ?? 0) > 0 || (proposal.context.series ?? 0) > 0) && <div className="ice-doc-muted">
        参考：{[...(proposal.context.references ?? []).map(title => `「${title}」`), proposal.context.series ? `系列前情 ${proposal.context.series} 期` : ""].filter(Boolean).join("、")}</div>}
      {open && <>
        {proposal.status === "generating" && <div className="ice-doc-row">
          <span className="ice-doc-muted">正在后台生成，你可以继续编辑；选中段落如被改动，对应修改会标为已过期。</span>
          <Button size="sm" variant="ghost" loading={busy === "cancel"} onClick={() => void cancel()}>取消</Button></div>}
        {proposal.status === "failed" && <div className="ice-assist__error">
          <span>{proposal.error || "生成失败"}</span>
          <Button size="sm" onClick={onRetry}>重试</Button></div>}
        {proposal.notes && <p className="ice-assist__notes">{proposal.notes}</p>}
        {proposal.ops.length > 0 && <ol className="ice-assist__ops">
          {proposal.ops.map((op, index) => <OpView key={op.op_id} op={op} state={states[index]} decidable={decidable}
            checked={checked.has(op.op_id)} onToggle={() => toggle(op.op_id)} onLocate={() => bridge.focusBlock(op.block_id)}
            accepted={proposal.decision.accepted?.includes(op.op_id) ?? false} />)}
        </ol>}
        {decidable && proposal.ops.length > 0 && <div className="ice-doc-row ice-assist__decide">
          {usable.length < proposal.ops.length && <span className="ice-doc-muted">{proposal.ops.length - usable.length} 处已过期</span>}
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" loading={busy === "dismiss"} onClick={() => void dismiss()}>全部放弃</Button>
          <Button size="sm" variant="primary" disabled={!chosen.length} loading={busy === "apply"} onClick={() => void apply(chosen)}>
            采纳所选（{chosen.length}）</Button>
        </div>}
        {decidable && !proposal.ops.length && <div className="ice-doc-row"><span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" loading={busy === "dismiss"} onClick={() => void dismiss()}>关闭</Button></div>}
        {canRevert && <div className="ice-doc-row"><span className="ice-doc-muted">采纳后已存为版本；之后没有再改时可直接撤销。</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" loading={busy === "revert"} onClick={() => void revert()}>撤销本次采纳</Button></div>}
      </>}
    </section>
  );
}

function Parts({ parts, kind }: { parts: DiffPart[]; kind: "del" | "add" }) {
  return <>{parts.map((part, index) => part.kind === "same" ? <span key={index}>{part.text}</span>
    : part.kind === kind ? <mark key={index} className={"ice-assist__" + kind}>{part.text}</mark> : null)}</>;
}

function OpView({ op, state, decidable, checked, accepted, onToggle, onLocate }: {
  op: ProposalOp; state: "ok" | "stale"; decidable: boolean; checked: boolean; accepted: boolean;
  onToggle: () => void; onLocate: () => void;
}) {
  const diff = React.useMemo(() => op.kind === "replace" ? inlineDiff(op.before_text, op.after_text) : null, [op]);
  const stale = state === "stale";
  return (
    <li className={"ice-assist__op" + (stale ? " is-stale" : "") + (accepted ? " is-accepted" : "")}>
      <div className="ice-doc-row">
        {decidable && <input type="checkbox" checked={checked && !stale} disabled={stale} onChange={onToggle}
                             aria-label={`采纳第 ${op.op_id.slice(2)} 处修改`} />}
        <span className="ice-assist__kind">{op.kind === "replace" ? "修改" : op.kind === "delete" ? "删除" : "插入图位"}</span>
        {stale && <span className="ice-doc-chip is-warn" title="原文在提案生成后被改过或已删除；这处修改仍可查看，但不会被套用">已过期</span>}
        {accepted && <span className="ice-doc-chip is-ok">已采纳</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="ice-link-btn" onClick={onLocate}>定位</button>
      </div>
      {op.kind === "replace" && diff && <div className="ice-assist__diff">
        <div className="ice-assist__before"><Parts parts={diff.before} kind="del" /></div>
        <div className="ice-assist__after"><Parts parts={diff.after} kind="add" /></div>
      </div>}
      {op.kind === "delete" && <div className="ice-assist__diff"><div className="ice-assist__before"><mark className="ice-assist__del">{op.before_text}</mark></div></div>}
      {op.kind === "insert_after" && <div className="ice-assist__diff">
        <div className="ice-doc-muted">插在「{op.before_text}」之后</div>
        <div className="ice-assist__after"><mark className="ice-assist__add">{op.after_text}</mark></div>
      </div>}
      {op.reason && <div className="ice-doc-muted">理由：{op.reason}</div>}
    </li>
  );
}
