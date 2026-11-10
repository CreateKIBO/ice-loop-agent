// v3.14 文章删除：移入回收站（可撤销）与永久删除（回收站内，二次确认，不可恢复）。
// 左栏、文章列表、编辑器共用；单独成模块，避免这些地方静态引用 ArticleHome。
import * as React from "react";

import { Button, Dialog } from "../../components/ui";
import { toast } from "../../components/toast";
import { documentStore } from "../../app/uiState";
import { accountStore, editorStore, flushAllDirty, queryClient } from "../../data/client";
import { docRpc, invalidateDocuments, pendingCache } from "./documentsApi";

type DeleteResult = { deleted: string[]; kept: Array<{ document_id: string; title: string; reason: string }> };

function refreshLists(account: string) {
  void invalidateDocuments(account);
  for (const method of ["documents.calendar", "documents.suggestions", "documents.variants"])
    void queryClient.invalidateQueries({ queryKey: ["ice", account, method] });
}

/** 移入回收站。正在编辑的文章先保存、再离开编辑器；提示里可一步撤销（撤销后重新打开原文章）。 */
export async function trashDocument(documentId: string, title: string) {
  const account = accountStore.get();
  const wasOpen = documentStore.get() === documentId;
  if (wasOpen) await flushAllDirty();
  await docRpc("documents.trash", { document_id: documentId, account_id: account });
  if (wasOpen && accountStore.get() === account && documentStore.get() === documentId) documentStore.set(null);
  refreshLists(account);
  toast.success({
    title: "已移入回收站", detail: `「${title || "未命名文章"}」可在文章首页的“回收站”里恢复。`,
    action: { label: "撤销", run: async () => {
      await docRpc("documents.untrash", { document_id: documentId, account_id: account });
      refreshLists(account);
      if (wasOpen && accountStore.get() === account && !documentStore.get()) { editorStore.set(null); documentStore.set(documentId); }
    } },
  });
}

/** 永久删除的确认框。target 为文章 id 列表，或 "all"（清空回收站）。 */
export function DeleteForeverDialog({ target, count, onClose, onDone }: {
  target: string[] | "all" | null; count: number; onClose: () => void; onDone?: (result: DeleteResult) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    if (!target) return;
    const account = accountStore.get();
    setBusy(true);
    try {
      const result = await docRpc<DeleteResult>("documents.delete_forever",
        target === "all" ? { all_trashed: true, account_id: account } : { document_ids: target, account_id: account });
      for (const id of result.deleted) {
        pendingCache.clear(account, id);
        queryClient.removeQueries({ predicate: query => query.queryKey[1] === account
          && (query.queryKey[3] as { document_id?: string } | undefined)?.document_id === id });
      }
      refreshLists(account);
      const kept = result.kept.map(item => `「${item.title || "未命名文章"}」${item.reason}`).join("；");
      if (result.deleted.length) toast.success({ title: `已永久删除 ${result.deleted.length} 篇`, detail: kept ? `保留 ${result.kept.length} 篇：${kept}` : undefined });
      else toast.warning({ title: "没有删除任何文章", detail: kept || "回收站里没有可删除的文章。" });
      onDone?.(result);
      onClose();
    } catch (error) { toast.error({ title: "没有删除", detail: (error as Error).message + "（整批未改动）" }); }
    finally { setBusy(false); }
  };
  const all = target === "all";
  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} width={460} initialFocus="[data-delete-cancel]"
      title={all ? "清空回收站？" : `永久删除 ${count} 篇文章？`}
      description="删除后正文、历史版本、导入原件、交付记录和 AI 修改建议都无法恢复。图片仍保留在素材库里；已登记发布或仍在生成的文章会留在回收站。"
      footer={<>
        <Button data-delete-cancel="" onClick={onClose} disabled={busy}>取消</Button>
        <Button variant="danger" loading={busy} onClick={() => void run()}>{all ? `清空（${count} 篇）` : "永久删除"}</Button>
      </>}>
      <p className="ice-doc-muted" style={{ margin: 0 }}>这一步不能撤销。只是暂时不想看到，可以留在回收站里。</p>
    </Dialog>
  );
}
