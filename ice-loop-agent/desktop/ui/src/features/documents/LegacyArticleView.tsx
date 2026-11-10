import * as React from "react";
import { Banner, Button, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { MarkdownView } from "../../components/MarkdownView";
import { toast } from "../../components/toast";
import { accountStore, editorStore, flushAllDirty, useAccountQuery, useCurrentAccount } from "../../data/client";
import { documentStore, setWorkspace } from "../../app/uiState";
import { RunResults } from "../tasks/ExecutionReview";
import type { TaskDetail } from "../tasks/taskTypes";
import { docRpc, invalidateDocuments, type DocumentDetail } from "./documentsApi";
import "../../styles/documents.css";

/** v3 原任务入口只查看历史；继续写作走普通文章，不修改原稿、审批或运行证据。 */
export function LegacyArticleView({ jobId }: { jobId: string }) {
  const account = useCurrentAccount();
  const detail = useAccountQuery<TaskDetail>("jobs.get", { job_id: jobId }, { staleTime: 0 });
  const draft = useAccountQuery<{ draft: { content: string } | null }>("articles.editor_draft_get", { job_id: jobId }, { staleTime: 0 });
  const [busy, setBusy] = React.useState(false);
  const copy = async (workingDraft: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await flushAllDirty();
      const result = workingDraft
        ? await docRpc<DocumentDetail>("documents.create", { account_id: account, kind: "markdown", title: "旧工作草稿（副本）", markdown: draft.data?.draft?.content ?? "" })
        : await docRpc<DocumentDetail>("documents.open_legacy", { account_id: account, origin: "legacy_job", origin_ref: jobId });
      void invalidateDocuments(account);
      if (accountStore.get() !== account) return;
      editorStore.set(null); setWorkspace("articles"); documentStore.set(result.document_id);
    } catch (error) { toast.error({ title: "旧稿没有接入", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return <div className="ice-doc-page" style={{ overflow: "auto", gap: 12 }}>
    <div className="ice-doc-row">
      <Button onClick={() => { editorStore.set(null); documentStore.set(null); setWorkspace("articles"); }}>返回文章列表</Button>
      <Button variant="primary" disabled={!detail.data} loading={busy} onClick={() => void copy(false)}>复制为新文章继续写</Button>
    </div>
    <Banner tone="info" title="原任务 · 只读历史">原正文、审批和运行记录保留。此入口不能保存正文、应用修改或启动代码执行；继续写作会打开独立文章。</Banner>
    {detail.isLoading && <Spinner />}
    {detail.error && <ErrorNote error={detail.error} onRetry={() => detail.refetch()} />}
    {detail.data && <>
      <h1>{detail.data.article.final_title || detail.data.article.topic}</h1>
      <MarkdownView text={detail.data.body || (detail.data as TaskDetail & { draft?: string }).draft || "（原任务尚无正文）"} />
      <RunResults detail={detail.data} />
    </>}
    {draft.error && <ErrorNote error={draft.error} onRetry={() => draft.refetch()} />}
    {draft.data?.draft && <details>
      <summary>旧编辑器还留有工作草稿（未覆盖原正文）</summary>
      <pre className="ice-doc-version-preview">{draft.data.draft.content}</pre>
      <Button disabled={busy} onClick={() => void copy(true)}>将旧工作草稿另存为文章</Button>
    </details>}
  </div>;
}
