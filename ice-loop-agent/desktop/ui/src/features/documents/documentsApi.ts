// v3 普通文章数据层：documents.* / bookmarks.* / publications.* 的类型与调用。
// 规范值是结构化文档 JSON（ADR-018）；Markdown 只是只读投影。
import { accountStore, queryClient, rpc } from "../../data/client";

export type DocTheme = "clean" | "magazine" | "tech" | "warm";
export type DocStyle = { theme: DocTheme; brandColor: string; fontSize: number; lineHeight: number; paragraphSpacing: number; letterSpacing?: number };
/** v3.2 文章设置：随版本冻结，随复制/导出交付。 */
export type DocInfo = { author?: string; summary?: string; sourceUrl?: string; coverResourceId?: string };
export type DocJSON = { type: "doc"; content?: Array<Record<string, unknown>> };
export type DocContent = { schema: 1; doc: DocJSON; style: DocStyle; info?: DocInfo };

export const DEFAULT_STYLE: DocStyle = { theme: "clean", brandColor: "#2563eb", fontSize: 17, lineHeight: 1.75, paragraphSpacing: 16 };
export const LETTER_SPACINGS = [0, 0.5, 1, 1.5, 2];
/** P2 排版主题：作用于标题、引用、代码块等；“简洁”与 v3.0 输出完全一致。 */
export const THEMES: Array<{ value: DocTheme; label: string; hint: string }> = [
  { value: "clean", label: "简洁", hint: "左边线小标题，通用" },
  { value: "magazine", label: "杂志", hint: "居中标题、细线分隔，适合长文与随笔" },
  { value: "tech", label: "科技", hint: "色块小标题、深色代码块，适合技术文" },
  { value: "warm", label: "温暖", hint: "圆角色块与暖色引用，适合生活类" },
];
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
  variant?: "A" | "B" | null; variant_group?: string | null; cover_resource_id?: string | null; planned_date?: string | null;
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
export type ImageSource = { kind: string; label: string; original_name: string; source_url: string; rights_note: string;
  derived_from: string; operation: { crop: unknown; max_width: number | null; format: string; quality: number | null; width: number; height: number } | null;
  imported_at: string; original_bytes: number | null; converted_from: string };
export type ImageView = { resource_id: string; title: string; width: number; height: number; mime: string; size: number; preview: string; ok: boolean;
  source?: ImageSource };
export type Bookmark = { bookmark_id: string; url: string; title: string; position: number; is_default: boolean };

export function docRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return rpc<T>(method, { account_id: accountStore.get(), ...params });
}

export function invalidateDocuments(account = accountStore.get()) {
  return queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.list"] });
}

export const PRODUCER_LABEL: Record<VersionSummary["producer"], string> = {
  user: "手动保存", autosave: "自动保存", checkpoint: "自动检查点", restore: "恢复", import: "导入",
  legacy: "旧稿接入", ai: "AI 生成/修改", delivery: "交付前保存", convert: "格式转换",
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

// ---------------------------------------------------------------- P1-01 文章内助手提案链
export type AssistAction = "rewrite" | "expand" | "compress" | "tone" | "image_slots" | "custom";
export const ASSIST_ACTIONS: Array<{ value: AssistAction; label: string; hint: string }> = [
  { value: "rewrite", label: "改写", hint: "保持原意，表达更清楚、更有节奏" },
  { value: "expand", label: "扩写", hint: "补充解释、例子或过渡，不编造事实" },
  { value: "compress", label: "压缩", hint: "约缩到一半，保留核心观点" },
  { value: "tone", label: "改语气", hint: "按选定语气调整措辞" },
  { value: "image_slots", label: "图位建议", hint: "通读全文，建议在哪里插入待配图位" },
  { value: "custom", label: "按我的要求", hint: "写下你希望怎样改" },
];
export const ASSIST_TONES = ["更口语", "更正式", "更犀利", "更温和", "更有趣"];
export type ProposalOp = {
  op_id: string; kind: "replace" | "delete" | "insert_after"; block_id: string;
  before_text: string; after_text: string; after: Array<Record<string, unknown>>; reason: string; state: "ok" | "stale";
};
export type ProposalStatus = "generating" | "ready" | "failed" | "cancelled" | "applied" | "partially_applied" | "rejected";
export type Proposal = {
  proposal_id: string; document_id: string; action: AssistAction; action_label: string; instruction: string;
  target_block_ids: string[]; status: ProposalStatus; notes: string; error: string; model_id: string;
  ops: ProposalOp[]; stale_count: number; created_at: string; finished_at: string | null; decided_at: string | null;
  context: { targets: number; chars: number; neighbors: boolean; outline: number; writing_skill: boolean; house_rules: boolean; tone: string | null;
    references?: string[]; series?: number };
  decision: { accepted?: string[]; rejected?: string[]; stale?: string[]; before_version_id?: string; history?: unknown[] };
};
export type AssistApplied = { proposal: Proposal; content: DocContent; revision: number; content_hash: string; version_id: string;
  applied?: string[]; stale?: string[]; saved_at: string };

// P1 两版对照
export type VariantInfo = { document_id: string; title: string; variant: "A" | "B" | null; generation_state: GenerationState;
  lifecycle: "active" | "trashed"; word_count: number; current: boolean; error: string };
