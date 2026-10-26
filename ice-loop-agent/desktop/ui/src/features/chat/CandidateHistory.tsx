import * as React from "react";
import { CopyButton } from "../../components/CopyButton";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Button, ErrorPanel, SkeletonRows } from "../../components/ui";
import { toast } from "../../components/toast";
import { errorCopy, diagnosticText } from "../../components/errorText";
import { refreshAfterWrite } from "../../data/receipts";
import { queryClient, rpc, useAccountQuery, useCurrentAccount } from "../../data/client";
import type { ChatResult } from "../../data/workbenchResponses";
import { CANDIDATE_WINDOW, type CandidatePosition } from "./historyWindow";
import { CandidateCompareDialog, compareStatusNote, toggleComparePick, type ComparePick } from "./CandidateCompare";

type CandidateView = {
  id: string; title: string; body: string; status: string;
  content_hash: string; prompts: string[];
  saved_draft?: { draft_id: string; changed: boolean } | null;
};

export function CandidateHistory({ conversationId, latest, refresh }: {
  conversationId: string; latest?: ChatResult; refresh: () => Promise<unknown>;
}) {
  const account = useCurrentAccount();
  const [position, setPosition] = React.useState<CandidatePosition | null>(null);
  const query = useAccountQuery<ChatResult>('chat.get', {
    conversation_id: conversationId, message_limit: 1, candidate_limit: CANDIDATE_WINDOW, ...position,
  }, { enabled: Boolean(position), gcTime: 0 });
  const data = position ? query.data : latest;
  const page = data?.candidate_page;
  const candidates = (data?.candidates ?? []) as CandidateView[];
  // 批A（2026-10-25 候选对照）：只选择“当前已加载页”的候选；不保留正文副本。
  // 翻页/切会话/切账号时选择失效——用 key 之外的范围比较实现就地清空（A6）。
  const [picks, setPicks] = React.useState<ComparePick[]>([]);
  const [compareNote, setCompareNote] = React.useState<string | null>(null);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const scope = account + ":" + conversationId + ":" + (position ? JSON.stringify(position) : "latest");
  const scopeRef = React.useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    setPicks([]); setCompareOpen(false); setCompareNote("候选页或会话已切换，对照选择已清空");
  }
  const loadedIds = React.useMemo(() => new Set(candidates.map(candidate => candidate.id)), [candidates]);
  const effectivePicks = picks.filter(pick => loadedIds.has(pick.id));
  const comparePair = effectivePicks.length === 2
    ? effectivePicks.map(pick => candidates.find(candidate => candidate.id === pick.id)!)
    : [];
  const togglePick = (candidate: CandidateView) => {
    const result = toggleComparePick(effectivePicks, { id: candidate.id, title: candidate.title, chars: candidate.body.length });
    setPicks(result.next);
    setCompareNote(result.note ?? null);
  };
  if (!position && !candidates.length) return null;
  return <section className="ice-chat-candidates" aria-label="会话候选稿">
    <div className="ice-chat-history">
      <strong>{position ? '历史候选稿' : '最近候选稿'}</strong>
      {page?.has_older && <Button size="sm" disabled={query.isFetching} onClick={() => setPosition({ before_candidate_id: page.oldest_id! })}>更早的候选稿</Button>}
      {position && <>
        {page?.has_newer && <Button size="sm" disabled={query.isFetching} onClick={() => setPosition({ after_candidate_id: page.newest_id! })}>更新的候选稿</Button>}
        <Button size="sm" onClick={() => setPosition(null)}>最近候选稿</Button>
      </>}
    </div>
    {position && query.isLoading && <SkeletonRows rows={2} />}
    {position && query.error && <ErrorPanel title="候选稿读取失败" detail={query.error.message} onRetry={() => query.refetch()} />}
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="ice-composer-note" role="status">{compareStatusNote(effectivePicks)}</span>
      {compareNote && <span className="ice-composer-note" role="status">{compareNote}</span>}
      <Button size="sm" variant={comparePair.length === 2 ? "primary" : "secondary"} disabled={comparePair.length !== 2}
              title={comparePair.length === 2 ? "并排只读对照两份候选（不修改状态）" : compareStatusNote(effectivePicks)}
              onClick={() => setCompareOpen(true)}>打开对照</Button>
    </div>
    {candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate}
      compareSelected={effectivePicks.some(pick => pick.id === candidate.id)}
      onToggleCompare={() => togglePick(candidate)}
      onChanged={async () => { await refresh(); if (position) await query.refetch({ throwOnError: true }); }} />)}
    {comparePair.length === 2 && <CandidateCompareDialog open={compareOpen} onOpenChange={setCompareOpen} pair={comparePair} narrow={typeof window !== "undefined" && window.innerWidth < 1000} />}
  </section>;
}

/** R12 批次二：初稿候选 → 显示正文 → 保存为草稿 → 提交审阅。保存 ≠ 采纳。 */
function CandidateCard({ candidate, onChanged, compareSelected, onToggleCompare }: { candidate: CandidateView; onChanged: () => Promise<unknown>;
  compareSelected: boolean; onToggleCompare: () => void }) {
  const account = useCurrentAccount();
  const [expanded, setExpanded] = React.useState(false);
  // 批B（2026-10-25）：展开后的阅读方式。原文=完整 Markdown 源文本；阅读=现有 MarkdownView
  // 真实排版（标题/列表/表格/引用/代码；链接与图片占位沿用消息区既有安全行为）。
  // 仅界面轻量状态：随卡片卸载消失，不写 localStorage、不影响草稿/审阅语义。
  const [reading, setReading] = React.useState(true);
  const [busy, setBusy] = React.useState<"save" | "submit" | null>(null);
  // 2026-10-20 交互验收：同 tick 连点会绕过 state 闭包守卫（与重命名同缺陷模式），ref 双闸。
  const busyRef = React.useRef(false);
  const guardBusy = (kind: "save" | "submit", run: () => Promise<void>) => async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try { await run(); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const [error, setError] = React.useState<string | null>(null);
  const [errorDetail, setErrorDetail] = React.useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = React.useState(false);
  const saved = candidate.saved_draft;
  const readOnly = !['draft', 'pending'].includes(candidate.status);
  const saveDraft = guardBusy("save", async () => {
    setError(null); setErrorDetail(null);
    try {
      await rpc("chat.save_draft", {
        candidate_id: candidate.id, content_hash: candidate.content_hash,
      });
      toast.success({ title: "已保存为草稿", detail: "在左栏「草稿箱」可随时查看；保存不等于采纳" });
      // 保存已成功；会话/草稿列表刷新失败单独提示（批次A-04）。
      await refreshAfterWrite("保存草稿", async () => {
        await onChanged();
        await queryClient.invalidateQueries({ queryKey: ["ice", account, "chat.drafts"] }, { throwOnError: true });
      });
    } catch (err) {
      const copy = errorCopy(err);
      setError(copy.title + (copy.nextStep ? "：" + copy.nextStep : ""));
      setErrorDetail(diagnosticText(err));
      setShowDiagnostics(false);
    }
    finally { /* busy 由 guardBusy 复位 */ }
  });
  const submitReview = guardBusy("submit", async () => {
    setError(null); setErrorDetail(null);
    try {
      await rpc("chat.submit", { candidate_id: candidate.id, content_hash: candidate.content_hash });
      toast.success({ title: "已提交人工审阅", detail: "审阅通过前不会发布" });
      await refreshAfterWrite("提交审阅", onChanged);
    } catch (err) {
      const copy = errorCopy(err);
      setError(copy.title + (copy.nextStep ? "：" + copy.nextStep : ""));
      setErrorDetail(diagnosticText(err));
      setShowDiagnostics(false);
    }
    finally { /* busy 由 guardBusy 复位 */ }
  });
  return (
    <div role="region" aria-label="初稿候选" style={{
      border: "1px solid var(--ice-signal-blue)", borderRadius: "var(--ice-radius-lg)",
      padding: "var(--ice-space-3)", background: "var(--ice-surface)", display: "grid", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ flexShrink: 0 }}>初稿候选</strong>
        {readOnly && <span>{({ accepted: '已采纳', rejected: '已拒绝' } as Record<string, string>)[candidate.status] ?? candidate.status}</span>}
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", flex: 1, minWidth: 0,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={candidate.title}>
          {candidate.title}
        </span>
        {saved && <span style={{ fontSize: 12, color: "var(--ice-success)", flexShrink: 0 }}>
          已保存草稿{saved.changed ? "（有新修改未保存）" : ""}
        </span>}
      </div>
      {!expanded && (
        <p className="ice-composer-note" style={{ margin: 0 }}>
          {candidate.body.slice(0, 120)}{candidate.body.length > 120 ? "…" : ""}（{candidate.body.length.toLocaleString()} 字符原文，展开查看）
        </p>
      )}
      {expanded && (
        <div className="ice-candidate-reader" style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} role="group" aria-label="候选正文查看方式">
            <Button size="sm" variant={reading ? "primary" : "secondary"} aria-pressed={reading}
                    onClick={() => setReading(true)}>阅读预览</Button>
            <Button size="sm" variant={!reading ? "primary" : "secondary"} aria-pressed={!reading}
                    onClick={() => setReading(false)}>Markdown 原文</Button>
            <span className="ice-composer-note">原文 {candidate.body.length.toLocaleString()} 字符（统计为 Markdown 源字符，非 Token/字数/费用）</span>
          </div>
          {reading ? (
            <div className="ice-markdown" style={{ maxHeight: 480, overflowY: "auto", background: "var(--ice-surface-muted)",
                                                   padding: 10, borderRadius: 8, fontSize: "var(--ice-font-size-sm)" }}>
              <MarkdownContent text={candidate.body} />
            </div>
          ) : (
            <pre style={{ margin: 0, maxHeight: 480, overflowY: "auto",
                          whiteSpace: "pre-wrap", fontFamily: "var(--ice-font-mono)", background: "var(--ice-surface-muted)",
                          padding: 10, borderRadius: 8, fontSize: "var(--ice-font-size-sm)" }}>
              {candidate.body}
            </pre>
          )}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: "var(--ice-font-size-sm)" }}>
          <span style={{ color: "var(--ice-danger)" }}>{error}</span>
          {errorDetail && (
            <>
              <button type="button" className="ice-link-btn" aria-expanded={showDiagnostics}
                      onClick={() => setShowDiagnostics(value => !value)}
                      style={{ marginLeft: 8 }}>
                {showDiagnostics ? "收起诊断" : "展开诊断"}
              </button>
              {showDiagnostics && (
                <div style={{ color: "var(--ice-text-secondary)", marginTop: 4,
                              fontFamily: "var(--ice-font-mono)", wordBreak: "break-all" }}>
                  {errorDetail}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button loading={busy === "save"} disabled={busy !== null || readOnly} onClick={saveDraft}>保存为草稿</Button>
        <Button variant="primary" loading={busy === "submit"} disabled={busy !== null || !saved || candidate.status === "pending" || readOnly}
                title={saved ? "提交人工审阅（不自动发布）" : "请先保存为草稿"}
                onClick={submitReview}>{candidate.status === "pending" ? "已提交审阅" : "提交审阅"}</Button>
        <button type="button" id={"candidate-expand-" + candidate.id} className="ice-link-btn" aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起" : "展开全文"}
        </button>
        <CopyButton text={candidate.body} label="复制全文" />
        <button type="button" className="ice-link-btn" aria-pressed={compareSelected}
                title={compareSelected ? "从对照中移除" : "加入对照（当前页最多两份）"}
                onClick={onToggleCompare}>{compareSelected ? "移出对照" : "加入对照"}</button>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
          保存草稿 ≠ 采纳/发布
        </span>
      </div>
    </div>
  );
}

