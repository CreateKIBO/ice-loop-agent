// v3 普通文章数据层：documents.* / bookmarks.* / publications.* 的类型与调用。
// 规范值是结构化文档 JSON（ADR-018）；Markdown 只是只读投影。
import { accountStore, queryClient, rpc } from "../../data/client";

export type DocStyle = { theme: "clean"; brandColor: string; fontSize: number; lineHeight: number; paragraphSpacing: number; letterSpacing?: number };
/** v3.2 文章设置：随版本冻结，随复制/导出交付。 */
export type DocInfo = { author?: string; summary?: string; sourceUrl?: string; coverResourceId?: string };
export type DocJSON = { type: "doc"; content?: Array<Record<string, unknown>> };
export type DocContent = { schema: 1; doc: DocJSON; style: DocStyle; info?: DocInfo };

export const DEFAULT_STYLE: DocStyle = { theme: "clean", brandColor: "#2563eb", fontSize: 17, lineHeight: 1.75, paragraphSpacing: 16 };
export const LETTER_SPACINGS = [0, 0.5, 1, 1.5, 2];
export const TITLE_LIMIT = 64, AUTHOR_LIMIT = 8, SUMMARY_LIMIT = 120;
export const HIGHLIGHTS = ["#fff3a3", "#ffe4c4", "#dcfce7", "#dbeafe", "#fce7f3", "#e5e7eb"];
export const FONT_SIZES = [14, 15, 16, 17, 18];
export const LINE_HEIGHTS = [1.5, 1.6, 1.75, 1.8, 2.0];
export const PARAGRAPH_SPACINGS = [0, 8, 12, 16, 20, 24];
export const INLINE_FONT_SIZES = ["12px", "13px", "14px", "15px", "16px", "17px", "18px", "20px", "22px", "24px"];

export type Origin = "blank" | "paste" | "import" | "ai" | "copy" | "legacy_draft" | "legacy_job";
export type GenerationState = "none" | "running" | "ready" | "failed" | "cancelled";

export type DocumentSummary = {
  id: string; document_id: string; kind: "document"; title: string; origin: Origin; origin_ref: string;
  series: string | null; episode: number | null; lifecycle: "active" | "trashed"; generation_state: GenerationState;
  updated_at: string; created_at: string; trashed_at: string | null; summary: string; word_count: number;
  images: number; published: boolean; source_label: string;
};
export type LegacyItem = {
  id: string; kind: "legacy_draft" | "legacy_job"; origin: "legacy_draft" | "legacy_job"; origin_ref: string;
  title: string; updated_at: string; series: string | null; episode: number | null; state?: string; source_label: string;
};
export type DocumentList = { documents: DocumentSummary[]; legacy: LegacyItem[]; account_id: string };

export type VersionSummary = {
  version_id: string; parent_version_id: string | null; content_hash: string; title: string;
  producer: "user" | "autosave" | "checkpoint" | "restore" | "import" | "legacy" | "ai" | "delivery" | "convert";
  note: string; created_at: string; word_count: number; images: number; published: boolean;
};
export type PublicationRecord = {
  record_id: string; document_id: string; version_id: string; delivery_id: string | null; url: string;
  published_at: string; note: string; source: "user_registered"; state: "active" | "withdrawn"; registered_at: string;
};
export type DeliveryRecord = { delivery_id: string; version_id: string; kind: "copy_html" | "copy_text" | "export";
  destination: string; created_at: string; delivery_hash: string };
export type ImportReport = {
  mode: "adapt" | "text"; paragraphs: number; headings: number; lists: number; quotes: number; code_blocks: number;
  images: { total: number; imported: number; missing: Array<{ src: string; alt: string; reason: string }> };
  islands: Array<{ reason: string; preview: string }>; styles: { mapped: number; ignored: Record<string, number> };
  dropped: Record<string, number>; characters: number;
};
export type DocumentDetail = Omit<DocumentSummary, "id" | "kind" | "summary" | "word_count" | "images" | "published"> & {
  meta: Record<string, unknown> & { error?: string; brief?: string; conversation_id?: string };
  head_version_id: string | null; content: DocContent; revision: number; content_hash: string;
  base_version_id: string | null; working_updated_at: string; head_version: Omit<VersionSummary, "word_count" | "images" | "published"> | null;
  unversioned_changes: boolean; word_count: number; publications: PublicationRecord[];
  imports: Array<{ import_id: string; kind: string; created_at: string; size: number; report: ImportReport }>;
  deliveries: DeliveryRecord[]; legacy_readonly: boolean;
  report?: ImportReport; import_id?: string;
};
export type SaveResult = { document_id: string; revision: number; content_hash: string; saved_at: string; unchanged: boolean; checkpoint: string | null }
  | { conflict: true; message: string; document_id: string; server: { revision: number; content_hash: string; updated_at: string; content: DocContent } };
export type DeliveryIssue = { severity: "error" | "warning" | "info"; kind: string; message: string; block_id: string };
export type DeliveryImage = { order: number; resource_id: string; caption: string; missing: boolean; block_id: string;
  mime?: string; size?: number; width?: number; height?: number; sha256?: string; source_url?: string; file_name?: string };
export type Delivery = {
  document_id: string; version_id: string; version_created_at: string; title: string; content_hash: string;
  delivery_hash: string; html: string; text: string; images: DeliveryImage[]; issues: DeliveryIssue[]; complete: boolean; style: DocStyle;
  info?: DocInfo;
  cover?: { resource_id: string; source: "explicit" | "first_image"; mime: string; width: number; height: number; file_name: string } | null;
};
export type ImageView = { resource_id: string; title: string; width: number; height: number; mime: string; size: number; preview: string; ok: boolean };
export type Bookmark = { bookmark_id: string; url: string; title: string; position: number; is_default: boolean };

export function docRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return rpc<T>(method, { account_id: accountStore.get(), ...params });
}

export function invalidateDocuments(account = accountStore.get()) {
  return queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.list"] });
}

export const PRODUCER_LABEL: Record<VersionSummary["producer"], string> = {
  user: "手动保存", autosave: "自动保存", checkpoint: "自动检查点", restore: "恢复", import: "导入",
  legacy: "旧稿接入", ai: "AI 初稿", delivery: "交付前保存", convert: "格式转换",
};
export const ORIGIN_LABEL: Record<Origin, string> = {
  blank: "新建", paste: "粘贴导入", import: "导入", ai: "AI 初稿", copy: "副本", legacy_draft: "旧草稿", legacy_job: "旧任务",
};

export function newBlockId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return "b" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** 本地崩溃恢复缓存：只存“尚未被引擎确认”的工作副本；读写失败不影响编辑。 */
export const pendingCache = {
  key: (account: string, id: string) => `ice.doc.pending.${account}.${id}`,
  read(account: string, id: string): { content: DocContent; title: string; base_revision: number; at: number } | null {
    try {
      const raw = window.localStorage.getItem(this.key(account, id));
      const value = raw ? JSON.parse(raw) : null;
      return value && typeof value.title === "string" && Number.isInteger(value.base_revision)
        && value.base_revision > 0 && value.content?.schema === 1 && value.content.doc?.type === "doc"
        && typeof value.content.style === "object" && value.content.style !== null ? value : null;
    } catch { return null; }
  },
  write(account: string, id: string, value: { content: DocContent; title: string; base_revision: number }) {
    try { window.localStorage.setItem(this.key(account, id), JSON.stringify({ ...value, at: Date.now() })); } catch { /* 存储满或被禁用 */ }
  },
  clear(account: string, id: string) { try { window.localStorage.removeItem(this.key(account, id)); } catch { /* ignore */ } },
};

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return "今天 " + time;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

export function formatBytes(size: number | undefined): string {
  if (!size) return "";
  if (size < 1024 * 1024) return Math.max(1, Math.round(size / 1024)) + " KB";
  return (size / 1024 / 1024).toFixed(1) + " MB";
}
