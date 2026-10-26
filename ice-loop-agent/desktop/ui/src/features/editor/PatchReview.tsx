// 逐项对比与采纳（M3-05/06/07）：提案列表 → 逐项前后对比 → accept/reject/
// 改后接受 → 提案决定；冲突逐项展示原因，不静默覆盖人工改稿。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, Dialog, EmptyState, Spinner } from "../../components/ui";
import { rpc, accountStore, dirtyStore, registerDirtyFlush, useCurrentAccount, type RpcError } from "../../data/client";
import { CopyButton } from "../../components/CopyButton";
import { inlineDiff, type DiffPart } from "./inlineDiff";
import { ReviewDraftPersistence, reviewDecisionCounts, type ReviewDecision as Decision, type ReviewDraft } from "./reviewDraftPersistence";

type Proposal = {
  proposal_id: string; base_revision: string; base_hash: string;
  base_document: { blocks: Array<Record<string, unknown>> };
  ops: Array<Record<string, unknown>>;
  reason: string; source_turn: string | null; status: string;
  outcome: { applied?: Array<Record<string, unknown>>; conflicts?: Array<Record<string, unknown>> } | null;
  created_at: string;
};

type ProposalSummary = Pick<Proposal, "proposal_id" | "base_revision" | "reason" | "status" | "created_at">;


export function PatchReview({ jobId, onApplied, bodyBlocked = false, beginApply }: {
  jobId: string; onApplied: () => void; bodyBlocked?: boolean; beginApply?: () => (() => void);
}) {
  const account = useCurrentAccount();
  const scope = jobId + ":" + account;
  const scopeRef = React.useRef(scope); scopeRef.current = scope;
  const mounted = React.useRef(true), submitting = React.useRef<string | null>(null), requestId = React.useRef(0);
  const acknowledged = React.useRef(new WeakSet<Proposal>());
  const [viewScope, setViewScope] = React.useState(scope);
  const [selectedProposal, setSelectedProposal] = React.useState("");
  const [positions, setPositions] = React.useState<Record<string, number>>({});
  const [errorTitle, setErrorTitle] = React.useState("提案加载失败");
  const [proposals, setProposals] = React.useState<ProposalSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [removeHandled, setRemoveHandled] = React.useState<string | null>(null);
  const [reloadDraft, setReloadDraft] = React.useState(false);
  const [confirm, setConfirm] = React.useState<Proposal | null>(null);
  const dirtyKey = "job:" + scope + ":review";
  const persistence = React.useMemo(() => new ReviewDraftPersistence(async (proposalId, baseHash, version, items) => {
    if (accountStore.get() !== account || scopeRef.current !== scope) throw Error("公众号已切换，审阅草稿未写入其他账号");
    const data = await rpc<{ draft: ReviewDraft }>("articles.proposal_draft_save", {
      job_id: jobId, proposal_id: proposalId, base_hash: baseHash, expected_version: version, decisions: items,
    });
    return data.draft;
  }), [account, jobId, scope]);
  React.useSyncExternalStore(persistence.subscribe, persistence.snapshot);
  React.useEffect(() => {
    const syncDirty = () => {
      if (persistence.dirty || submitting.current === scope) dirtyStore.markDirty(dirtyKey);
      else dirtyStore.markClean(dirtyKey);
    };
    syncDirty();
    const off = persistence.subscribe(syncDirty);
    const unregister = registerDirtyFlush(dirtyKey, async () => {
      if (submitting.current === scope) throw Error("正在提交审阅决定，请等待完成再切换");
      await persistence.flush();
    });
    return () => { persistence.cancelTimer(); off(); unregister(); };
  }, [dirtyKey, persistence, scope]);
  const [working, setWorking] = React.useState<string | null>(null);
  const [pages, setPages] = React.useState<Array<string | null>>([null]);
  const cursor = pages[pages.length - 1];
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [listLoading, setListLoading] = React.useState(false);
  const [detail, setDetail] = React.useState<Proposal | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [detailTick, setDetailTick] = React.useState(0);
  const [result, setResult] = React.useState<{ status: string; conflicts: Array<Record<string, unknown>> } | null>(null);

  const reload = React.useCallback(async (afterWrite = false) => {
    const id = ++requestId.current, currentScope = scope;
    const current = () => mounted.current && scopeRef.current === currentScope && id === requestId.current;
    setListLoading(true);
    try {
      const data = await rpc<{ proposals: ProposalSummary[]; next_cursor: string | null }>("articles.proposals_page", { job_id: jobId, limit: 20, cursor });
      if (!current()) return;
      setProposals(data.proposals); setNextCursor(data.next_cursor); setError(null);
    } catch (err) {
      if (!current()) return;
      setErrorTitle(afterWrite ? "决定已处理，但提案列表刷新失败" : "提案加载失败");
      setError((err as Error).message);
    } finally { if (current()) setListLoading(false); }
  }, [jobId, scope, cursor]);
  React.useEffect(() => {
    mounted.current = true;
    setViewScope(scope);
    acknowledged.current = new WeakSet<Proposal>();
    setWorking(null); setProposals(null); setConfirm(null); setReloadDraft(false); setRemoveHandled(null); setSelectedProposal(""); setPositions({}); setResult(null); setError(null); setPages([null]); setNextCursor(null); setDetail(null);
    return () => { mounted.current = false; requestId.current++; };
  }, [scope]);
  React.useEffect(() => { void reload(); }, [reload]);

  const setDecision = (proposalId: string, _opIndex: number, decision: Decision) => {
    if (!submitting.current && !confirm && !persistence.retiredRecords().some(record => record.id === proposalId)) persistence.edit(proposalId, decision);
  };

  const submit = async (proposal: Proposal) => {
    if (accountStore.get() !== account || scopeRef.current !== scope || submitting.current === scope || acknowledged.current.has(proposal) || persistence.retiredRecords().some(record => record.id === proposal.proposal_id)) return;
    submitting.current = scope;
    const currentScope = scope;
    const current = () => mounted.current && scopeRef.current === currentScope;
    setWorking(proposal.proposal_id);
    dirtyStore.markDirty(dirtyKey);
    setError(null);
    let releaseBody: (() => void) | undefined;
    try {
      const ops = proposal.ops.map((_op, index) =>
        persistence.decisions(proposal.proposal_id)[index] ?? { op_index: index, decision: "accept" as const });
      if (ops.some(item => item.decision !== "reject")) releaseBody = beginApply?.();
      await persistence.flush();
      const outcome = await rpc<{ status: string; conflicts: Array<Record<string, unknown>>; revision_id: string | null }>(
        "articles.proposal_decide", { job_id: jobId, proposal_id: proposal.proposal_id, decisions: ops, review_version: persistence.version(proposal.proposal_id) });
      if (!current()) return;
      acknowledged.current.add(proposal);
      setResult({ status: outcome.status, conflicts: outcome.conflicts });
      // A confirmed write must never leave the old submit button usable after a read failure.
      setProposals(previous => previous?.filter(p => p.proposal_id !== proposal.proposal_id) ?? []);
      persistence.forget(proposal.proposal_id);
      setConfirm(null);
      if (outcome.revision_id) onApplied();
      await reload(true);
    } catch (err) {
      if (current()) { setConfirm(null); setErrorTitle("提交决定未完成"); setError((err as RpcError).message); if ((err as RpcError).message.includes("工作草稿")) onApplied(); }
    } finally {
      releaseBody?.();
      if (submitting.current === currentScope) submitting.current = null;
      if (current()) { setWorking(null); if (!persistence.dirty) dirtyStore.markClean(dirtyKey); }
    }
  };

  const activeId = viewScope === scope ? (proposals?.find(p => p.proposal_id === selectedProposal) ?? proposals?.[0])?.proposal_id : undefined;
  React.useEffect(() => {
    let cancelled = false;
    const currentScope = scope;
    setDetail(null); setDetailError(null);
    if (activeId) void rpc<{ proposal: Proposal; review_draft: ReviewDraft | null }>("articles.proposal_get", { job_id: jobId, proposal_id: activeId }).then(data => {
      if (!cancelled && scopeRef.current === currentScope) {
        if (data.proposal.status === "pending") persistence.install(data.proposal.proposal_id, data.proposal.base_hash, data.review_draft);
        else persistence.retire(data.proposal.proposal_id, data.proposal.status);
        setDetail(data.proposal);
      }
    }).catch((err: Error) => { if (!cancelled && scopeRef.current === currentScope) setDetailError(err.message); });
    return () => { cancelled = true; };
  }, [activeId, jobId, scope, detailTick, persistence]);
  const matchingDetail = detail?.proposal_id === activeId ? detail : null;
  const activeProposal = matchingDetail?.status === "pending" ? matchingDetail : null;
  const handledRecords = persistence.retiredRecords();

  const restoreSavedDecisions = async () => {
    if (!matchingDetail || submitting.current === scope) return;
    const id = matchingDetail.proposal_id;
    submitting.current = scope; setWorking(id); dirtyStore.markDirty(dirtyKey);
    try {
      await persistence.settle();
      const data = await rpc<{ proposal: Proposal; review_draft: ReviewDraft | null }>("articles.proposal_get", { job_id: jobId, proposal_id: id });
      if (!mounted.current || scopeRef.current !== scope) return;
      if (data.proposal.status === "pending") persistence.replace(id, data.proposal.base_hash, data.review_draft);
      else persistence.retire(id, data.proposal.status);
      setDetail(data.proposal); setReloadDraft(false); setError(null);
    } catch (error) {
      if (mounted.current && scopeRef.current === scope) { setReloadDraft(false); setErrorTitle("重新读取未完成，当前审阅输入已保留"); setError((error as Error).message); }
    } finally {
      if (submitting.current === scope) submitting.current = null;
      if (mounted.current && scopeRef.current === scope) { setWorking(null); if (!persistence.dirty) dirtyStore.markClean(dirtyKey); }
    }
  };

  if (viewScope !== scope || (proposals === null && !error)) {
    return <div style={{ display: "grid", placeItems: "center", padding: 16 }}><Spinner size={14} /></div>;
  }

  return (
    <section aria-label="修改提案" style={{ borderTop: "1px solid var(--ice-border)", paddingTop: "var(--ice-space-3)", display: "grid", gap: "var(--ice-space-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: "var(--ice-font-size-md)" }}>修改提案</strong>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
          选段修改逐项采纳；人工改稿的段落不会被覆盖。
        </span>
      </div>
      {error && <Banner tone="danger" title={errorTitle} actions={<div style={{ display: "grid", gap: 6 }}><Button disabled={Boolean(working)} onClick={() => void reload(Boolean(result))}>重新读取列表</Button>{activeProposal && <Button disabled={Boolean(working)} onClick={() => setReloadDraft(true)}>核对已保存审阅</Button>}</div>}>{error}</Banner>}
      <div role="status" aria-label="审阅草稿保存状态" style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
        {handledRecords.length > 0 ? "已处理提案的本地审阅记录待核对" : persistence.state === "saving" ? "正在保存审阅草稿…" : persistence.state === "dirty" ? "审阅决定尚未保存…" : persistence.state === "error" ? "审阅草稿保存失败，输入仍保留" : "审阅草稿已保存 · 保存不会修改正文"}
      </div>
      {persistence.error && handledRecords.length === 0 && <Banner tone="danger" title="审阅草稿未保存" actions={<div style={{ display: "grid", gap: 6 }}><Button disabled={Boolean(working)} onClick={() => void persistence.flush().catch(() => undefined)}>重试保存审阅草稿</Button><Button disabled={Boolean(working) || !activeProposal} onClick={() => setReloadDraft(true)}>重新读取已保存决定</Button></div>}>{persistence.error}</Banner>}
      {bodyBlocked && <Banner tone="warning" title="请先处理正文修改再应用提案">
        正文有尚未保存为版本的修改或恢复草稿，请先保存新版本或处理恢复草稿。你仍可逐项审阅、自动保存决定，或拒绝整份提案。
      </Banner>}
      {result && (
        <Banner tone={result.status === "applied" ? "success" : result.status === "partially_applied" ? "warning" : "info"}
                title={RESULT_LABEL[result.status] ?? result.status}
                actions={<Button variant="ghost" onClick={() => setResult(null)}>知道了</Button>}>
          {result.conflicts.length > 0
            ? "冲突项："
            + result.conflicts.map(c => String((c as { reason?: string }).reason ?? "未知原因")).join("；")
            : result.status === "applied" ? "全部修改已应用到新版本。" : "本次没有应用新的修改，请核对处理结果。"}
        </Banner>
      )}
      {(proposals ?? []).length === 0 && !error && (
        <EmptyState title="暂无待处理的修改提案" hint="在对话中选择段落后让 Agent 提出修改，会出现在这里。" />
      )}
      {(proposals?.length ?? 0) > 0 && <label>选择修改提案
        <select aria-label="选择修改提案" value={activeId ?? ""} disabled={Boolean(working) || listLoading}
          onChange={event => setSelectedProposal(event.target.value)} style={{ maxWidth: "100%" }}>
          {proposals?.map((p, index) => <option key={p.proposal_id} value={p.proposal_id}>{index + 1}. {p.reason || "选段修改"}</option>)}
        </select>
      </label>}
      <div role="group" aria-label="提案分页" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Button disabled={Boolean(working) || listLoading || pages.length <= 1} onClick={() => { setProposals(null); setSelectedProposal(""); setPages(previous => previous.slice(0, -1)); }}>上一页提案</Button>
        <span role="status">第 {pages.length} 页 · 本页 {proposals?.length ?? 0} 份 · 每页最多20份{listLoading ? " · 正在读取" : ""}</span>
        <Button disabled={Boolean(working) || listLoading || !nextCursor} onClick={() => { if (nextCursor) { setProposals(null); setSelectedProposal(""); setPages(previous => [...previous, nextCursor]); } }}>下一页提案</Button>
      </div>
      {detailError && <Banner tone="danger" title="提案详情读取失败" actions={<Button onClick={() => setDetailTick(tick => tick + 1)}>重新读取详情</Button>}>{detailError}</Banner>}
      {activeId && !matchingDetail && !detailError && <span role="status">正在读取选中提案…</span>}
      {handledRecords.map(record => <HandledReview key={record.id} record={record} onRemove={() => setRemoveHandled(record.id)} />)}
      <Dialog open={Boolean(removeHandled)} onOpenChange={open => { if (!open) setRemoveHandled(null); }} title="移除本地审阅记录"
        description="这份提案已经处理。确认后只移除当前页面保留的审阅选择和手改文字，不撤销已处理结果，也不修改正文或其他提案。" initialFocus="[data-handled-cancel]"
        footer={<><Button data-handled-cancel onClick={() => setRemoveHandled(null)}>继续保留</Button><Button variant="danger" onClick={() => {
          if (!removeHandled) return;
          persistence.forget(removeHandled);
          setProposals(previous => previous?.filter(p => p.proposal_id !== removeHandled) ?? []);
          if (detail?.proposal_id === removeHandled) setDetail(null);
          setRemoveHandled(null); setError(null); onApplied();
        }}>确认移除本地记录</Button></>}>
        <p>若仍需要这些文字，请先取消并复制本地审阅记录。其他提案的未保存输入继续保留。</p>
      </Dialog>
      <Dialog open={reloadDraft} onOpenChange={open => { if (!working) setReloadDraft(open); }} title="重新读取已保存的审阅决定"
        description="当前提案尚未保存的审阅选择与手改文字将被已保存内容替换，文章正文不会变化。其他提案的未保存输入会继续保留。" initialFocus="[data-review-reload-cancel]"
        footer={<><Button data-review-reload-cancel disabled={Boolean(working)} onClick={() => setReloadDraft(false)}>保留当前输入</Button>
          <Button variant="danger" loading={Boolean(working)} onClick={() => void restoreSavedDecisions()}>确认重新读取</Button></>}>
        <p>仅在你确认放弃当前提案的未保存审阅时使用。读取失败会继续保留当前输入。</p>
      </Dialog>
      <Dialog open={Boolean(confirm)} onOpenChange={open => { if (!open && !working) setConfirm(null); }}
        title="确认提交审阅决定" description="保存草稿不会应用修改；本次确认后才会更新文章版本。" initialFocus="[data-review-cancel]"
        footer={<><Button data-review-cancel disabled={Boolean(working)} onClick={() => setConfirm(null)}>继续检查</Button>
          <Button variant="primary" loading={Boolean(working)} disabled={Boolean(confirm && bodyBlocked && reviewDecisionCounts(confirm.ops.length, persistence.decisions(confirm.proposal_id)).reject !== confirm.ops.length)} onClick={() => { if (confirm) void submit(confirm); }}>确认并应用决定</Button></>}>
        {confirm && (() => {
          const counts = reviewDecisionCounts(confirm.ops.length, persistence.decisions(confirm.proposal_id));
          return <div style={{ display: "grid", gap: 8 }}>
            <strong>{confirm.reason || "选段修改"}</strong>
            <p role="status" aria-label="审阅决定摘要">接受 {counts.accept} 项 · 拒绝 {counts.reject} 项 · 改后接受 {counts.new_text} 项 · 未决定 {counts.undecided} 项</p>
            {counts.undecided > 0 && <Banner tone="warning" title="未决定项将按接受处理">本次还有 {counts.undecided} 项未明确选择。可点击「继续检查」逐项审阅，或确认按接受处理。</Banner>}
            {counts.reject === confirm.ops.length && <p>全部拒绝将关闭此提案，文章正文不会发生变化。</p>}
            <p>若正文已被人工修改，冲突项会保留并说明原因。</p>
          </div>;
        })()}
      </Dialog>
      <AnimatePresence initial={false} mode="wait">
        {(activeProposal ? [activeProposal] : []).map(proposal => (
          <motion.article key={proposal.proposal_id} layout
                          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
                          style={{ border: "1px solid var(--ice-border)", borderRadius: "var(--ice-radius-lg)",
                                   padding: "var(--ice-space-3)", display: "grid", gap: "var(--ice-space-2)",
                                   background: "var(--ice-surface)" }}>
            <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <strong>{proposal.reason || "选段修改"}</strong>
                <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
                  基线 {proposal.base_revision.slice(0, 12)}
                  {proposal.source_turn ? " · 来自 " + proposal.source_turn : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
                <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", whiteSpace: "nowrap" }}>
                  已决定 {Object.keys(persistence.decisions(proposal.proposal_id)).length}/{proposal.ops.length}，其余按接受
                </span>
                <Button variant="primary" loading={working === proposal.proposal_id}
                        disabled={Boolean(working)} onClick={() => setConfirm(proposal)}>提交决定</Button>
              </div>
            </header>
            <div role="group" aria-label="修改项导航" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <Button disabled={Boolean(working) || (positions[proposal.proposal_id] ?? 0) <= 0}
                onClick={() => setPositions(previous => ({ ...previous, [proposal.proposal_id]: Math.max(0, (previous[proposal.proposal_id] ?? 0) - 1) }))}>上一项修改</Button>
              <label>跳转修改项 <select aria-label="跳转修改项" disabled={Boolean(working)} value={Math.min(positions[proposal.proposal_id] ?? 0, Math.max(0, proposal.ops.length - 1))}
                onChange={event => setPositions(previous => ({ ...previous, [proposal.proposal_id]: Number(event.target.value) }))}>
                {proposal.ops.map((_op, index) => <option key={index} value={index}>第 {index + 1} 项{persistence.decisions(proposal.proposal_id)[index] ? " · 已决定" : " · 未决定"}</option>)}
              </select></label>
              <Button disabled={Boolean(working) || (positions[proposal.proposal_id] ?? 0) >= proposal.ops.length - 1}
                onClick={() => setPositions(previous => ({ ...previous, [proposal.proposal_id]: (previous[proposal.proposal_id] ?? 0) + 1 }))}>下一项修改</Button>
              <span role="status">共 {proposal.ops.length} 项修改 · 当前仅展开一项</span>
            </div>
            {proposal.ops.map((op, index) => {
              if (index !== Math.min(positions[proposal.proposal_id] ?? 0, Math.max(0, proposal.ops.length - 1))) return null;
              const decision = persistence.decisions(proposal.proposal_id)[index];
              const baseBlock = (proposal.base_document.blocks ?? []).find(
                block => block.block_id === op.block_id) as { source?: string } | undefined;
              const oldText = String(baseBlock?.source ?? "（块不存在）");
              const kind = String(op.op);
              const proposedText = kind === "delete" ? ""
                : typeof op.text === "string" ? op.text : JSON.stringify(op.new_block ?? {});
              const edited = decision?.decision === "new_text";
              const newText = edited ? (decision.text ?? "") : proposedText;
              // 用户自己改过的文本也按"替换"展示差异，便于核对改了哪里。
              const view = edited ? "replace" : kind;
              return (
                <div key={index} style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
                    第 {index + 1} 项 · {OP_LABEL[kind] ?? kind}
                    {decision && <span className="ice-badge" style={{ marginLeft: 8 }}>{DECISION_LABEL[decision.decision]}</span>}
                  </div>
                  <ChangeView view={view} oldText={oldText} newText={newText} />
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Button disabled={Boolean(working)} variant={decision?.decision === "accept" ? "primary" : "secondary"}
                            aria-pressed={decision?.decision === "accept"}
                            onClick={() => setDecision(proposal.proposal_id, index, { op_index: index, decision: "accept" })}>接受</Button>
                    <Button disabled={Boolean(working)} variant={edited ? "primary" : "secondary"}
                            aria-pressed={edited}
                            onClick={() => setDecision(proposal.proposal_id, index, {
                              // 在提案文本上微调，而不是让用户从原文重打一遍
                              op_index: index, decision: "new_text", text: proposedText || oldText })}>改后接受</Button>
                    <Button disabled={Boolean(working)} variant={decision?.decision === "reject" ? "danger" : "ghost"}
                            aria-pressed={decision?.decision === "reject"}
                            onClick={() => setDecision(proposal.proposal_id, index, { op_index: index, decision: "reject" })}>拒绝</Button>
                    {decision?.decision === "new_text" && (
                      <textarea disabled={Boolean(working)} value={decision.text} rows={2} aria-label="修改后的文本"
                                onChange={event => setDecision(proposal.proposal_id, index, {
                                  op_index: index, decision: "new_text", text: event.target.value })}
                                style={{ flex: 1, minWidth: 200, fontFamily: "var(--ice-font-ui)",
                                         padding: 6, borderRadius: 6, border: "1px solid var(--ice-border)" }} />
                    )}
                  </div>
                </div>
              );
            })}
          </motion.article>
        ))}
      </AnimatePresence>
    </section>
  );
}

const RESULT_LABEL: Record<string, string> = {
  applied: "全部应用成功", partially_applied: "部分应用（有冲突项）",
  rejected: "没有可应用的修改", conflict: "存在冲突，未应用",
};
const OP_LABEL: Record<string, string> = {
  replace: "替换内容", delete: "删除该块", insert_after: "在其后插入",
};
const DECISION_LABEL: Record<Decision["decision"], string> = {
  accept: "将接受", new_text: "将改后接受", reject: "将拒绝",
};

function Parts({ parts }: { parts: DiffPart[] }) {
  return <>{parts.map((part, index) => part.kind === "same"
    ? <React.Fragment key={index}>{part.text}</React.Fragment>
    : <span key={index} className={part.kind === "add" ? "ice-diff-add" : "ice-diff-del"}>{part.text}</span>)}</>;
}

/** 替换：两栏字符级差异；删除：原文整段标红；插入：新文整段标绿，左栏只是插入位置。 */
function ChangeView({ view, oldText, newText }: { view: string; oldText: string; newText: string }) {
  const diff = React.useMemo(
    () => (view === "replace" ? inlineDiff(oldText, newText) : null), [view, oldText, newText]);
  const left = view === "insert_after" ? "插入位置（在此块之后）" : "原内容";
  return (
    <div className="ice-diff">
      <figure className="ice-diff__side">
        <figcaption>{left}</figcaption>
        <pre aria-label={left}>
          {diff ? <Parts parts={diff.before} />
            : view === "delete" ? <span className="ice-diff-del">{oldText}</span> : oldText}
        </pre>
      </figure>
      <figure className="ice-diff__side ice-diff__side--new">
        <figcaption>新内容{diff?.truncated ? "（段落过长，按整段对比）" : ""}</figcaption>
        <pre aria-label="新内容">
          {diff ? <Parts parts={diff.after} />
            : view === "delete" ? <span className="ice-diff-empty">（整块删除）</span>
            : <span className="ice-diff-add">{newText}</span>}
        </pre>
      </figure>
    </div>
  );
}


function HandledReview({ record, onRemove }: {
  record: { id: string; status: string; items: Record<number, Decision> }; onRemove: () => void;
}) {
  const text = React.useMemo(() => JSON.stringify({ proposal_id: record.id, remote_status: record.status,
    local_decisions: Object.values(record.items) }, null, 2), [record.id, record.status, record.items]);
  return <div style={{ display: "grid", gap: 8, border: "1px solid var(--ice-border)", borderRadius: 8, padding: 12 }}>
    <strong>提案已在别处处理 · {RESULT_LABEL[record.status] ?? record.status}</strong>
    <p>本地审阅记录仍保留，不会再次提交。提案 {record.id}；请核对或复制后明确移除本地记录。</p>
    {Object.keys(record.items).length > 0 && <textarea readOnly aria-label="已保留的本地审阅记录" value={text} rows={4} style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }} />}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <CopyButton text={text} label="复制本地审阅记录" />
      <Button onClick={onRemove}>移除已处理提案的本地记录</Button>
    </div>
  </div>;
}
