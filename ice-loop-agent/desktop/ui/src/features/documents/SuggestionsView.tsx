// P2 建议管理：集中查看各篇文章里待采纳、生成中、失败的 AI 修改提案；可打开到对应文章的助手，或批量放弃。
import * as React from "react";

import { Button, EmptyState, SkeletonRows, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { documentPanelStore } from "../../app/uiState";
import { docRpc, formatTime } from "./documentsApi";
import { openDocument } from "./documentNav";

type Suggestion = { proposal_id: string; document_id: string; title: string; action_label: string; instruction: string;
  status: "generating" | "ready" | "failed"; ops: number; stale: number; notes: string; error: string; created_at: string };
type Overview = { items: Suggestion[]; counts: Record<string, number> };

export function SuggestionsView() {
  const account = useCurrentAccount();
  const data = useAccountQuery<Overview>("documents.suggestions", {}, {
    staleTime: 0, refetchInterval: query => ((query.state.data as Overview | undefined)?.counts.generating ? 3000 : 30_000),
  });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const items = data.data?.items ?? [];
  const decidable = items.filter(item => item.status !== "generating");
  const open = async (item: Suggestion) => {
    try { await openDocument(item.document_id); documentPanelStore.set({ panel: "assist", at: Date.now() }); }
    catch (error) { toast.error({ title: "无法打开文章", detail: (error as Error).message }); }
  };
  const dismiss = async (ids: string[]) => {
    setBusy(true);
    try {
      const next = await docRpc<Overview>("documents.suggestions_dismiss", { proposal_ids: ids });
      queryClient.setQueryData(["ice", account, "documents.suggestions", {}], next);
      setSelected(new Set());
      toast.success({ title: `已放弃 ${ids.length} 条建议`, detail: "正文没有改动；提案记录仍保留在各文章的助手里。" });
    } catch (error) { toast.error({ title: "没有放弃", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (data.isLoading) return <SkeletonRows rows={4} height={24} />;
  if (data.error) return <ErrorNote error={data.error} onRetry={() => data.refetch()} retryLabel="重新读取建议" />;
  if (!items.length) return <EmptyState title="没有待处理的建议" hint="在文章里用“AI 助手”发起改写、扩写或图位建议后，未处理的提案会集中显示在这里。" />;
  return (
    <section className="ice-suggest" aria-label="待处理建议">
      <div className="ice-doc-row">
        <span className="ice-doc-muted">待采纳 {data.data?.counts.ready ?? 0} · 生成中 {data.data?.counts.generating ?? 0} · 失败 {data.data?.counts.failed ?? 0}</span>
        <span style={{ flex: 1 }} />
        {decidable.length > 0 && <button type="button" className="ice-link-btn"
          onClick={() => setSelected(selected.size === decidable.length ? new Set() : new Set(decidable.map(item => item.proposal_id)))}>
          {selected.size === decidable.length ? "取消全选" : "全选可处理项"}</button>}
        <Button size="sm" variant="ghost" disabled={!selected.size} loading={busy} onClick={() => void dismiss([...selected])}>放弃所选（{selected.size}）</Button>
      </div>
      <ul className="ice-doc-list">
        {items.map(item => <li key={item.proposal_id} className="ice-doc-row-card">
          <div className="ice-suggest__check">
            {item.status !== "generating" ? <input type="checkbox" checked={selected.has(item.proposal_id)} onChange={() => toggle(item.proposal_id)}
                                                   aria-label={`选择「${item.title}」的${item.action_label}建议`} /> : <Spinner size={12} />}
          </div>
          <button type="button" className="ice-doc-row-card__main" onClick={() => void open(item)}>
            <span className="ice-doc-row-card__title">{item.title || "未命名文章"}</span>
            <span className="ice-doc-row-card__summary">{item.status === "failed" ? (item.error || "生成失败")
              : item.status === "generating" ? "正在生成…" : item.notes || `${item.ops} 处修改待你确认`}</span>
            <span className="ice-doc-row-card__meta">
              <span className="ice-doc-chip">{item.action_label}{item.instruction ? `·${item.instruction.slice(0, 12)}` : ""}</span>
              {item.status === "ready" && <span className="ice-doc-chip is-busy">{item.ops} 处待采纳</span>}
              {item.stale > 0 && <span className="ice-doc-chip is-warn">{item.stale} 处已过期</span>}
              {item.status === "failed" && <span className="ice-doc-chip is-bad">失败</span>}
              <span>{formatTime(item.created_at)}</span>
            </span>
          </button>
          <div className="ice-doc-row-card__actions"><Button size="sm" variant="ghost" onClick={() => void open(item)}>去处理</Button></div>
        </li>)}
      </ul>
    </section>
  );
}
