// P1 两版对照：同一次“生成两个版本”的 AI 初稿互相对照；保留一版时另一版移入回收站（可恢复）。
import * as React from "react";

import { Button, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { MarkdownContent } from "../../components/MarkdownContent";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { docRpc, invalidateDocuments, type VariantInfo } from "./documentsApi";
import { openDocument } from "./documentNav";

export function DocumentVariants({ documentId }: { documentId: string }) {
  const account = useCurrentAccount();
  const variants = useAccountQuery<VariantInfo[]>("documents.variants", { document_id: documentId }, {
    staleTime: 0,
    refetchInterval: query => ((query.state.data as VariantInfo[] | undefined) ?? []).some(v => v.generation_state === "running") ? 3000 : false,
  });
  const others = (variants.data ?? []).filter(v => !v.current);
  const [selected, setSelected] = React.useState<string | null>(null);
  const other = others.find(v => v.document_id === selected) ?? others[0];
  const markdown = useAccountQuery<{ markdown: string }>("documents.markdown", { document_id: other?.document_id ?? "" },
    { enabled: Boolean(other && other.generation_state !== "running" && other.lifecycle === "active"), staleTime: 0 });
  const self = (variants.data ?? []).find(v => v.current);
  const [busy, setBusy] = React.useState(false);

  const keep = async () => {
    if (!other) return;
    setBusy(true);
    try {
      await docRpc("documents.trash", { document_id: other.document_id });
      toast.success({ title: `已保留版本 ${self?.variant ?? ""}`, detail: `版本 ${other.variant} 已移入回收站，可以随时恢复。` });
      void invalidateDocuments(account);
      void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.variants"] });
    } catch (error) { toast.error({ title: "没有完成", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };

  if (variants.isLoading) return <div className="ice-doc-muted"><Spinner size={12} /> 正在读取另一版…</div>;
  if (variants.error) return <ErrorNote error={variants.error} onRetry={() => variants.refetch()} retryLabel="重新读取" />;
  if (!other) return <p className="ice-doc-muted">没有找到同组的另一版。</p>;
  return (
    <div className="ice-doc-variant">
      <p className="ice-doc-muted">左边编辑器里是版本 {self?.variant}；这里只读显示版本 {other.variant}。两版是同一需求、不同切入角度的独立文章，互不覆盖。</p>
      {others.length > 1 && <div className="ice-doc-variant__tabs">
        {others.map(v => <button key={v.document_id} type="button" className={"ice-doc-chip" + (v.document_id === other.document_id ? " is-busy" : "")}
          onClick={() => setSelected(v.document_id)}>版本 {v.variant}</button>)}
      </div>}
      <div className="ice-doc-row">
        <strong>版本 {other.variant}：{other.title}</strong>
        <span style={{ flex: 1 }} />
        <span className="ice-doc-muted">{other.word_count} 字</span>
      </div>
      {other.lifecycle === "trashed" ? <p className="ice-doc-muted">版本 {other.variant} 已在回收站中，可从文章列表的回收站恢复。</p>
        : other.generation_state === "running" ? <div className="ice-doc-muted"><Spinner size={12} /> 版本 {other.variant} 还在生成…</div>
        : other.generation_state === "failed" ? <p className="ice-doc-muted">版本 {other.variant} 没有生成成功：{other.error || "生成失败"}</p>
        : <div className="ice-doc-variant__body">
            {markdown.isLoading ? <Spinner size={12} /> : markdown.error
              ? <ErrorNote error={markdown.error} onRetry={() => markdown.refetch()} retryLabel="重新读取" />
              : <MarkdownContent text={markdown.data?.markdown ?? ""} />}
          </div>}
      {other.lifecycle === "active" && <div className="ice-doc-row">
        <Button size="sm" onClick={() => void openDocument(other.document_id)}>打开版本 {other.variant} 编辑</Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="primary" loading={busy} disabled={other.generation_state === "running"} onClick={() => void keep()}>
          保留版本 {self?.variant}，另一版移入回收站</Button>
      </div>}
    </div>
  );
}
