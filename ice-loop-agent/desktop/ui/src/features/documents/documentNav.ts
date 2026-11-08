// 文章导航辅助：左栏、日历、建议、两版对照等处共用。
// 单独成模块，避免这些地方静态引用 ArticleHome，使文章首页无法按需加载（构建时的静态/动态混合导入提示）。
import { documentStore } from "../../app/uiState";
import { editorStore, flushAllDirty } from "../../data/client";
import { docRpc, invalidateDocuments, type DocumentDetail } from "./documentsApi";

export async function openDocument(documentId: string) {
  await flushAllDirty();
  editorStore.set(null);
  documentStore.set(documentId);
}

export async function createBlankDocument() {
  await flushAllDirty();
  const created = await docRpc<DocumentDetail>("documents.create", { kind: "blank", title: "未命名文章" });
  void invalidateDocuments();
  editorStore.set(null);
  documentStore.set(created.document_id);
}
