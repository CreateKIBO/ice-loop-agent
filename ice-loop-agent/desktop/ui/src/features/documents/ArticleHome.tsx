// 文章首页（C-01）：默认入口。空白 / 粘贴 / AI 起草三种开始方式；无模型、无栏目也能完成手动流程。
// 统一索引：v3 文章 + 尚未接入的旧草稿/旧任务（打开时按映射接入，不改写原文）。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, Dialog, EmptyState, Input, SkeletonRows, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { editorStore, flushAllDirty, useAccountQuery, useCurrentAccount } from "../../data/client";
import { articleCreateStore, documentStore, settingsStore } from "../../app/uiState";
import { useModelReadiness } from "../../app/modelBootstrap";
import {
  ORIGIN_LABEL, docRpc, formatTime, invalidateDocuments,
  type DocumentDetail, type DocumentList, type DocumentSummary, type LegacyItem,
} from "./documentsApi";
import "../../styles/documents.css";

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

export function ArticleHome() {
  const account = useCurrentAccount();
  const [lifecycle, setLifecycle] = React.useState<"active" | "trashed">("active");
  const [query, setQuery] = React.useState("");
  const deferred = React.useDeferredValue(query.trim());
  const list = useAccountQuery<DocumentList>("documents.list", { lifecycle, query: deferred },
    { staleTime: 2_000, refetchInterval: data => (data.state.data?.documents.some(d => d.generation_state === "running") ? 4_000 : 30_000) });
  const dialog = articleCreateStore.use();
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { setLifecycle("active"); setQuery(""); }, [account]);

  const blank = async () => {
    if (creating) return;
    setCreating(true);
    try { await createBlankDocument(); }
    catch (error) { toast.error({ title: "没有新建文章", detail: (error as Error).message }); }
    finally { setCreating(false); }
  };
  const documents = list.data?.documents ?? [];
  const legacy = list.data?.legacy ?? [];

  return (
    <div className="ice-doc-home">
      <header className="ice-doc-home__head">
        <div>
          <h1>文章</h1>
          <p className="ice-doc-muted">写作、排版、配图与交付都在这里完成；不需要模型、栏目或期号。</p>
        </div>
      </header>
      <div className="ice-doc-starts">
        <button type="button" className="ice-doc-start" disabled={creating} onClick={() => void blank()}>
          <strong>{creating ? "正在新建…" : "空白文章"}</strong><span>从一页白纸开始写</span></button>
        <button type="button" className="ice-doc-start" onClick={() => articleCreateStore.set("paste")}>
          <strong>粘贴导入</strong><span>从网页、公众号或 Word 粘贴，附导入报告</span></button>
        <button type="button" className="ice-doc-start" onClick={() => articleCreateStore.set("ai")}>
          <strong>AI 起草</strong><span>描述需求，后台生成独立初稿</span></button>
      </div>
      <div className="ice-doc-home__filters">
        <Input type="search" value={query} placeholder="搜索标题或开头" aria-label="搜索文章" onChange={event => setQuery(event.target.value)}
               style={{ flex: 1 }} />
        <div className="ice-segmented" role="group" aria-label="文章筛选">
          <button type="button" aria-pressed={lifecycle === "active"} onClick={() => setLifecycle("active")}>全部文章</button>
          <button type="button" aria-pressed={lifecycle === "trashed"} onClick={() => setLifecycle("trashed")}>回收站</button>
        </div>
      </div>
      {list.isLoading && <SkeletonRows rows={6} height={18} />}
      {list.error && <ErrorNote error={list.error} onRetry={() => list.refetch()} retryLabel="重新读取文章" />}
      {!list.isLoading && !list.error && documents.length === 0 && legacy.length === 0 && (
        <EmptyState title={lifecycle === "trashed" ? "回收站是空的" : query ? "没有匹配的文章" : "还没有文章"}
                    hint={lifecycle === "trashed" || query ? undefined : "选择上方任一种方式开始第一篇。"} />
      )}
      <ul className="ice-doc-list" aria-label="文章列表">
        <AnimatePresence initial={false}>
          {documents.map(item => <motion.li key={item.document_id} layout="position" initial={{ opacity: 0, y: 4 }}
                                            animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }}>
            <DocumentRow item={item} trashed={lifecycle === "trashed"} />
          </motion.li>)}
        </AnimatePresence>
      </ul>
      {lifecycle === "active" && legacy.length > 0 && <section className="ice-doc-legacy-list">
        <h2>旧稿件 <span className="ice-doc-muted">· {legacy.length}</span></h2>
        <p className="ice-doc-muted">旧草稿和旧制作任务在打开时接入为独立文章，原数据保持不变；旧任务的审批和运行记录只读保留。</p>
        <ul className="ice-doc-list">{legacy.map(item => <li key={item.id}><LegacyRow item={item} /></li>)}</ul>
      </section>}
      <PasteDialog open={dialog === "paste"} onClose={() => articleCreateStore.set(null)} />
      <AiDraftDialog open={dialog === "ai"} onClose={() => articleCreateStore.set(null)} />
    </div>
  );
}

function DocumentRow({ item, trashed }: { item: DocumentSummary; trashed: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const act = async (method: string, label: string) => {
    setBusy(true);
    try { await docRpc(method, { document_id: item.document_id }); await invalidateDocuments(); toast.success({ title: label }); }
    catch (error) { toast.error({ title: label + "失败", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const state = item.generation_state;
  return (
    <div className="ice-doc-row-card">
      <button type="button" className="ice-doc-row-card__main" disabled={trashed} onClick={() => void openDocument(item.document_id)}>
        <span className="ice-doc-row-card__title">{item.title || "未命名文章"}</span>
        <span className="ice-doc-row-card__summary">{state === "running" ? "AI 正在后台生成初稿…" : state === "failed" ? "AI 初稿没有完成，可手动写或重新起草" : item.summary || "（空白）"}</span>
        <span className="ice-doc-row-card__meta">
          {state === "running" && <span className="ice-doc-chip is-busy"><Spinner size={10} /> 生成中</span>}
          {state === "failed" && <span className="ice-doc-chip is-bad">生成失败</span>}
          {item.published && <span className="ice-doc-chip is-ok">已登记发布</span>}
          <span className="ice-doc-chip">{item.source_label || ORIGIN_LABEL[item.origin]}</span>
          {item.series && <span className="ice-doc-chip">{item.series}{item.episode ? `·${item.episode}` : ""}</span>}
          <span>{item.word_count} 字 · {item.images} 图 · {formatTime(item.updated_at)}</span>
        </span>
      </button>
      <div className="ice-doc-row-card__actions">
        {busy ? <Spinner size={12} /> : trashed
          ? <Button size="sm" variant="ghost" onClick={() => void act("documents.untrash", "已恢复文章")}>恢复</Button>
          : <>
            <Button size="sm" variant="ghost" disabled={state === "running"} onClick={() => void act("documents.duplicate", "已复制为新文章")}>复制</Button>
            <Button size="sm" variant="ghost" onClick={() => void act("documents.trash", "已移入回收站")}>删除</Button>
          </>}
      </div>
    </div>
  );
}

function LegacyRow({ item }: { item: LegacyItem }) {
  const [busy, setBusy] = React.useState(false);
  const open = async () => {
    setBusy(true);
    try {
      await flushAllDirty();
      const document = await docRpc<DocumentDetail>("documents.open_legacy", { origin: item.origin, origin_ref: item.origin_ref });
      void invalidateDocuments();
      editorStore.set(null);
      documentStore.set(document.document_id);
    } catch (error) { toast.error({ title: "旧稿没有接入", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <div className="ice-doc-row-card is-legacy">
      <button type="button" className="ice-doc-row-card__main" disabled={busy} onClick={() => void open()}>
        <span className="ice-doc-row-card__title">{item.title}</span>
        <span className="ice-doc-row-card__meta">
          <span className="ice-doc-chip">{item.source_label}</span>
          {item.series && <span className="ice-doc-chip">{item.series}{item.episode ? `·${item.episode}` : ""}</span>}
          <span>{formatTime(item.updated_at)}</span>
        </span>
      </button>
      <div className="ice-doc-row-card__actions">
        {busy ? <Spinner size={12} /> : <>
          <Button size="sm" variant="ghost" onClick={() => void open()}>{item.kind === "legacy_job" ? "复制为新文章继续写" : "打开"}</Button>
          {item.kind === "legacy_job" && <Button size="sm" variant="ghost" title="只读查看原任务（不能再运行代码）"
            onClick={() => void flushAllDirty().then(() => { documentStore.set(null); editorStore.set(item.origin_ref); })}>查看原任务</Button>}
        </>}
      </div>
    </div>
  );
}

function PasteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = React.useState<"adapt" | "text">("adapt");
  const [captured, setCaptured] = React.useState<{ html: string; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (!open) { setCaptured(null); setBusy(false); } }, [open]);
  const submit = async () => {
    if (!captured) return;
    setBusy(true);
    try {
      await flushAllDirty();
      const params = captured.html.trim() ? { html: captured.html, mode } : { text: captured.text };
      const document = await docRpc<DocumentDetail>("documents.import_paste", params);
      const report = document.report;
      void invalidateDocuments();
      onClose();
      editorStore.set(null);
      documentStore.set(document.document_id);
      if (report) {
        const warnings = [report.images.missing.length ? `${report.images.missing.length} 张图片需要替换` : "",
          report.islands.length ? `${report.islands.length} 个模块保留为只读原件` : ""].filter(Boolean);
        (warnings.length ? toast.warning : toast.success)({ title: "已导入为新文章",
          detail: `${report.paragraphs} 段，图片 ${report.images.imported}/${report.images.total}。${warnings.join("，")}${warnings.length ? "。" : ""}原始内容已留档，可在“版本”中找回。` });
      }
    } catch (error) { toast.error({ title: "导入失败", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title="粘贴导入" width={640}
            description="从网页、公众号后台或 Word 复制后，在下方区域按 Ctrl+V。图片和不支持的模块会在导入报告中列出。"
            footer={<><Button onClick={onClose}>取消</Button>
              <Button variant="primary" loading={busy} disabled={!captured} onClick={() => void submit()}>导入为新文章</Button></>}>
      <div className="ice-doc-form">
        <div className="ice-doc-pastezone" tabIndex={0} role="textbox" aria-label="在此粘贴" contentEditable suppressContentEditableWarning
             onPaste={event => {
               event.preventDefault();
               const html = event.clipboardData.getData("text/html"), text = event.clipboardData.getData("text/plain");
               if (!html.trim() && !text.trim()) { toast.warning({ title: "剪贴板里没有文字或网页内容", detail: "图片请在文章编辑器中直接粘贴。" }); return; }
               setCaptured({ html, text });
             }} onKeyDown={event => { if (!(event.ctrlKey || event.metaKey)) event.preventDefault(); }}>
          {captured ? <span>已读取：{captured.html.trim() ? "网页格式内容" : "纯文本"}，约 {Math.max(captured.text.length, 1)} 字。可再次粘贴替换。</span>
            : <span className="ice-doc-muted">点击这里，然后按 Ctrl+V 粘贴</span>}
        </div>
        <div className="ice-segmented" role="group" aria-label="粘贴方式">
          <button type="button" aria-pressed={mode === "adapt"} onClick={() => setMode("adapt")}>适配当前样式</button>
          <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>仅保留文字</button>
        </div>
        <p className="ice-doc-muted">{mode === "adapt" ? "保留标题、列表、引用、加粗/颜色等受支持的格式；复杂模块保存为只读原件，不会静默丢失。"
          : "所有结构降为段落，不保留图片。导入后仍可切换回“适配当前样式”。"}</p>
      </div>
    </Dialog>
  );
}

function AiDraftDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const readiness = useModelReadiness();
  const [brief, setBrief] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const requestId = React.useRef<string | null>(null);
  React.useEffect(() => { if (!open) { setBusy(false); requestId.current = null; } }, [open]);
  const ready = readiness === "ready" || readiness === "untested";
  const submit = async () => {
    if (brief.trim().length < 4) return;
    setBusy(true);
    requestId.current ??= crypto.randomUUID().replace(/-/g, "");
    try {
      const document = await docRpc<DocumentDetail>("documents.ai_draft_start", { brief: brief.trim(), request_id: requestId.current });
      void invalidateDocuments();
      onClose(); setBrief("");
      if (document.generation_state === "failed") toast.error({ title: "AI 起草没有启动", detail: String(document.meta.error ?? "请检查模型配置") });
      else toast.info({ title: "已在后台开始生成", detail: "完成后自动保存为独立的 AI 初稿，出现在文章列表；你可以继续当前工作。",
        action: { label: "打开", run: () => openDocument(document.document_id) } });
    } catch (error) { toast.error({ title: "AI 起草没有启动", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title="AI 起草" width={600}
            description="生成结果会保存为一篇独立的“AI 初稿”，不会覆盖任何已有文章；生成失败会如实标出。"
            footer={<><Button onClick={onClose}>取消</Button>
              <Button variant="primary" loading={busy} disabled={!ready || brief.trim().length < 4} onClick={() => void submit()}>开始生成</Button></>}>
      <div className="ice-doc-form">
        {!ready && <div className="ice-doc-readiness is-bad">还没有可用的写作模型。手动写作不受影响；如需 AI 起草，请先
          <button type="button" className="ice-link-btn" onClick={() => settingsStore.set(true)}>配置模型</button>。</div>}
        <textarea className="ice-doc-textarea" rows={7} value={brief} maxLength={4000} placeholder="例如：写一篇 1500 字左右的家庭收纳经验分享，面向刚搬家的年轻人，语气轻松，分 4 个小标题。"
                  onChange={event => setBrief(event.target.value)} aria-label="文章需求" />
      </div>
    </Dialog>
  );
}
