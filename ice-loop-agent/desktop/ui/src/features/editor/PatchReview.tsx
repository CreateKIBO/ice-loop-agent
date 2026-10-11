// 逐项对比与采纳（M3-05/06/07）：提案列表 → 逐项前后对比 → accept/reject/
// 改后接受 → 提案决定；冲突逐项展示原因，不静默覆盖人工改稿。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, EmptyState, Spinner } from "../../components/ui";
import { rpc, type RpcError } from "../../data/client";
import { inlineDiff, type DiffPart } from "./inlineDiff";

type Proposal = {
  proposal_id: string; base_revision: string; base_hash: string;
  base_document: { blocks: Array<Record<string, unknown>> };
  ops: Array<Record<string, unknown>>;
  reason: string; source_turn: string | null; status: string;
  outcome: { applied?: Array<Record<string, unknown>>; conflicts?: Array<Record<string, unknown>> } | null;
  created_at: string;
};

type Decision = { op_index: number; decision: "accept" | "reject" | "new_text"; text?: string };

export function PatchReview({ jobId, onApplied }: {
  jobId: string; onApplied: () => void;
}) {
  const [proposals, setProposals] = React.useState<Proposal[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [decisions, setDecisions] = React.useState<Record<string, Record<number, Decision>>>({});
  const [working, setWorking] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ status: string; conflicts: Array<Record<string, unknown>> } | null>(null);

  const reload = React.useCallback(() => {
    rpc<{ proposals: Proposal[] }>("articles.proposals_list", { job_id: jobId, include_decided: false })
      .then(data => { setProposals(data.proposals); setError(null); })
      .catch((err: Error) => setError(err.message));
  }, [jobId]);
  React.useEffect(reload, [reload]);

  const setDecision = (proposalId: string, opIndex: number, decision: Decision) => {
    setDecisions(previous => ({
      ...previous,
      [proposalId]: { ...(previous[proposalId] ?? {}), [opIndex]: decision },
    }));
  };

  const submit = async (proposal: Proposal) => {
    setWorking(proposal.proposal_id);
    setError(null);
    try {
      const ops = proposal.ops.map((_op, index) =>
        decisions[proposal.proposal_id]?.[index] ?? { op_index: index, decision: "accept" as const });
      const outcome = await rpc<{ status: string; conflicts: Array<Record<string, unknown>>; revision_id: string | null }>(
        "articles.proposal_decide", { job_id: jobId, proposal_id: proposal.proposal_id, decisions: ops });
      setResult({ status: outcome.status, conflicts: outcome.conflicts });
      setDecisions(previous => {
        const next = { ...previous };
        delete next[proposal.proposal_id];
        return next;
      });
      reload();
      if (outcome.revision_id) onApplied();
    } catch (err) {
      setError((err as RpcError).message);
    } finally {
      setWorking(null);
    }
  };

  if (proposals === null && !error) {
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
      {error && <Banner tone="danger" title="提案加载失败">{error}</Banner>}
      {result && (
        <Banner tone={result.status === "applied" ? "success" : result.status === "partially_applied" ? "warning" : "info"}
                title={RESULT_LABEL[result.status] ?? result.status}
                actions={<Button variant="ghost" onClick={() => setResult(null)}>知道了</Button>}>
          {result.conflicts.length > 0
            ? "冲突项："
            + result.conflicts.map(c => String((c as { reason?: string }).reason ?? "未知原因")).join("；")
            : "全部修改已应用到新版本。"}
        </Banner>
      )}
      {(proposals ?? []).length === 0 && !error && (
        <EmptyState title="暂无待处理的修改提案" hint="在对话中选择段落后让 Agent 提出修改，会出现在这里。" />
      )}
      <AnimatePresence initial={false}>
        {(proposals ?? []).map(proposal => (
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
                  已决定 {Object.keys(decisions[proposal.proposal_id] ?? {}).length}/{proposal.ops.length}，其余按接受
                </span>
                <Button variant="primary" loading={working === proposal.proposal_id}
                        onClick={() => submit(proposal)}>提交决定</Button>
              </div>
            </header>
            {proposal.ops.map((op, index) => {
              const decision = decisions[proposal.proposal_id]?.[index];
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
                    <Button variant={decision?.decision === "accept" ? "primary" : "secondary"}
                            aria-pressed={decision?.decision === "accept"}
                            onClick={() => setDecision(proposal.proposal_id, index, { op_index: index, decision: "accept" })}>接受</Button>
                    <Button variant={edited ? "primary" : "secondary"}
                            aria-pressed={edited}
                            onClick={() => setDecision(proposal.proposal_id, index, {
                              // 在提案文本上微调，而不是让用户从原文重打一遍
                              op_index: index, decision: "new_text", text: proposedText || oldText })}>改后接受</Button>
                    <Button variant={decision?.decision === "reject" ? "danger" : "ghost"}
                            aria-pressed={decision?.decision === "reject"}
                            onClick={() => setDecision(proposal.proposal_id, index, { op_index: index, decision: "reject" })}>拒绝</Button>
                    {decision?.decision === "new_text" && (
                      <textarea value={decision.text} rows={2} aria-label="修改后的文本"
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
