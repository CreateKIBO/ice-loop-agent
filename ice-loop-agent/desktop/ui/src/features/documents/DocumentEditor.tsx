// v3 普通文章编辑器（A-02/A-03/B-01/B-02/B-03）：不需要 jobId、模型、栏目或期号。
// 保存链：输入 → 本地恢复缓存 → 800ms 写工作副本（revision 乐观并发）→ 显式/交付时冻结为版本。
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, ErrorPanel, Input, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { accountStore, dirtyStore, flushAllDirty, registerDirtyFlush, useCurrentAccount, useObjectDirty } from "../../data/client";
import { conversationStore } from "../../data/client";
import { documentStore, setWorkspace } from "../../app/uiState";
import {
  DEFAULT_STYLE, INLINE_FONT_SIZES, docRpc, formatTime, invalidateDocuments, pendingCache,
  type DocContent, type DocStyle, type DocumentDetail, type ImageView, type ImportReport, type SaveResult,
} from "./documentsApi";
import { ArticleImage, BlockId, DocImageSlot, DocRawBlock, DocRunOutput, RawHtml, TextAlign, TextStyle, imageActions } from "./docExtensions";
import { DocumentSidePanel } from "./DocumentSidePanel";
import "../../styles/documents.css";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type Conflict = Extract<SaveResult, { conflict: true }>;
type PasteState = { html: string; mode: "adapt" | "text"; report: ImportReport; seq: number } | null;

const COLORS = ["#111827", "#6b7280", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777"];

export async function pickDocumentImage(): Promise<ImageView | null> {
  const pick = window.ice?.pickDocumentImage as undefined | ((accountId: string) => Promise<ImageView | null>);
  if (typeof pick !== "function") { toast.warning({ title: "请在桌面应用中插入图片", detail: "也可以直接粘贴或拖入图片。" }); return null; }
  try { return await pick(accountStore.get()); }
  catch (error) { toast.error({ title: "图片没有导入", detail: (error as Error).message }); return null; }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export function DocumentEditor({ documentId }: { documentId: string }) {
  const account = useCurrentAccount();
  const [data, setData] = React.useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setLoadError(null);
    docRpc<DocumentDetail>("documents.get", { document_id: documentId })
      .then(value => { if (active) setData(value); })
      .catch(error => { if (active) setLoadError((error as Error).message); });
    return () => { active = false; };
  }, [documentId, account, tick]);
  // AI 初稿生成中：后台轮询，不抢焦点；完成后原地载入。
  React.useEffect(() => {
    if (data?.generation_state !== "running") return;
    const timer = window.setTimeout(() => setTick(value => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [data]);

  if (loadError && !data) return <div className="ice-doc-page"><ErrorPanel title="文章打开失败" detail={loadError} onRetry={() => setTick(v => v + 1)} /></div>;
  if (!data) return <div className="ice-doc-page ice-doc-center"><Spinner size={20} /></div>;
  if (data.generation_state === "running") return <GeneratingView data={data} />;
  return <LoadedEditor key={data.document_id + ":" + data.content_hash.slice(0, 8) + ":" + (data.head_version_id ?? "")}
                       initial={data} onReload={() => setTick(v => v + 1)} />;
}

function GeneratingView({ data }: { data: DocumentDetail }) {
  return <div className="ice-doc-page ice-doc-center">
    <div className="ice-doc-generating">
      <Spinner size={18} />
      <h2>AI 初稿正在后台生成</h2>
      <p>完成后会自动保存为这篇独立文章。生成期间你可以回到文章列表继续编辑其他文章，不会被打断。</p>
      {data.meta.brief && <blockquote>{String(data.meta.brief)}</blockquote>}
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <Button onClick={() => documentStore.set(null)}>回到文章列表</Button>
        {data.meta.conversation_id && <Button variant="ghost" onClick={() => { setWorkspace("assistant"); conversationStore.set(String(data.meta.conversation_id)); }}>在助手中查看进度</Button>}
      </div>
    </div>
  </div>;
}

function LoadedEditor({ initial, onReload }: { initial: DocumentDetail; onReload: () => void }) {
  const account = useCurrentAccount();
  const documentId = initial.document_id;
  const dirtyKey = "doc:" + documentId;
  const dirty = useObjectDirty(dirtyKey);
  const [title, setTitle] = React.useState(initial.title);
  const [style, setStyle] = React.useState<DocStyle>({ ...DEFAULT_STYLE, ...initial.content.style });
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const [savedAt, setSavedAt] = React.useState(initial.working_updated_at);
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const [unversioned, setUnversioned] = React.useState(initial.unversioned_changes);
  const [panel, setPanel] = React.useState<"style" | "versions" | "delivery" | null>(null);
  const [paste, setPaste] = React.useState<PasteState>(null);
  const [pasting, setPasting] = React.useState(false);
  const [recovery, setRecovery] = React.useState(() => {
    const pending = pendingCache.read(account, documentId);
    return pending;
  });
  const revision = React.useRef(initial.revision);
  const sequence = React.useRef(0);
  const timer = React.useRef<number | undefined>(undefined);
  const saving = React.useRef<Promise<void> | null>(null);
  const titleRef = React.useRef(initial.title);
  const styleRef = React.useRef(style);
  const editorRef = React.useRef<Editor | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const content = React.useCallback((): DocContent | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    return { schema: 1, doc: editor.getJSON() as DocContent["doc"], style: styleRef.current };
  }, []);

  const saveNow = React.useCallback(async (force = false): Promise<void> => {
    if (saving.current) return saving.current;
    const run = (async () => {
      do {
      const value = content();
      if (!value) return;
      const seq = sequence.current;
      setSaveState("saving");
      try {
        const result = await docRpc<SaveResult>("documents.save_working", {
          account_id: account, document_id: documentId, content: value, base_revision: revision.current, title: titleRef.current, force,
        });
        if ("conflict" in result) {
          if (mounted.current) { setConflict(result); setSaveState("conflict"); }
          return;
        }
        revision.current = result.revision;
        // 覆盖只适用于用户明确选择的这一笔，后续输入继续正常检查修订号。
        force = false;
        if (!result.unchanged) setUnversioned(true);
        if (mounted.current) { setSavedAt(result.saved_at); setConflict(null); setSaveError(null); }
        if (seq === sequence.current) {
          dirtyStore.markClean(dirtyKey);
          pendingCache.clear(account, documentId);
          if (mounted.current) setSaveState("saved");
        } else {
          const latest = content();
          if (latest) pendingCache.write(account, documentId, { content: latest, title: titleRef.current, base_revision: revision.current });
        }
        if (result.checkpoint) void invalidateDocuments(account);
      } catch (error) {
        if (mounted.current) { setSaveState("error"); setSaveError(error); }
        throw error;
      }
      } while (mounted.current && dirtyStore.isDirty(dirtyKey));
    })();
    saving.current = run;
    try { await run; }
    finally {
      saving.current = null;
    }
  }, [account, content, dirtyKey, documentId]);

  const getRevision = React.useCallback(() => revision.current, []);
  const flush = React.useCallback(async () => {
    window.clearTimeout(timer.current);
    if (dirtyStore.isDirty(dirtyKey)) await saveNow();
    if (dirtyStore.isDirty(dirtyKey)) throw new Error("文章有未保存的修改（可能存在版本冲突），请先处理后再离开");
  }, [dirtyKey, saveNow]);

  const schedule = React.useCallback(() => {
    sequence.current += 1;
    dirtyStore.markDirty(dirtyKey);
    setSaveState(state => state === "conflict" ? state : "dirty");
    const value = content();
    if (value) pendingCache.write(account, documentId, { content: value, title: titleRef.current, base_revision: revision.current });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void saveNow().catch(() => undefined); }, 800);
  }, [account, content, dirtyKey, documentId, saveNow]);

  // 导航（切文章/会话/账号/关闭）前立即落盘；冲突或失败时阻止离开。
  React.useEffect(() => {
    const off = registerDirtyFlush(dirtyKey, flush);
    return () => { off(); window.clearTimeout(timer.current); };
  }, [dirtyKey, flush]);

  const insertImageFiles = React.useCallback(async (files: File[]) => {
    for (const file of files.slice(0, 20)) {
      try {
        const dataUrl = await readAsDataURL(file);
        const image = await docRpc<ImageView>("documents.image_import_data", { data_url: dataUrl, name: file.name.replace(/\.[^.]+$/, "") });
        editorRef.current?.chain().focus().insertContent({ type: "articleImage", attrs: { resourceId: image.resource_id, caption: "", width: 100, align: "center" } }).run();
      } catch (error) { toast.error({ title: `「${file.name}」没有导入`, detail: (error as Error).message }); }
    }
  }, []);

  const convertPaste = React.useCallback(async (html: string, mode: "adapt" | "text") => {
    setPasting(true);
    try {
      const result = await docRpc<{ content: DocContent; report: ImportReport }>("documents.convert_paste",
        { html, mode, style: styleRef.current, document_id: documentId });
      const editor = editorRef.current;
      if (!editor || !mounted.current) return;
      editor.chain().focus().insertContent(result.content.doc.content ?? []).run();
      setPaste({ html, mode, report: result.report, seq: sequence.current });
    } catch (error) { toast.error({ title: "粘贴内容没有转换", detail: (error as Error).message }); }
    finally { if (mounted.current) setPasting(false); }
  }, [documentId]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["https", "http", "mailto"] } }),
      BlockId, TextAlign, TextStyle, ArticleImage, RawHtml, DocImageSlot, DocRunOutput, DocRawBlock,
    ],
    content: initial.content.doc,
    editorProps: {
      attributes: { class: "ice-doc-prose", "aria-label": "文章正文", spellcheck: "false" },
      handlePaste: (_view, event) => {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        const html = clipboard.getData("text/html");
        const files = Array.from(clipboard.files as ArrayLike<File>).filter((file: File) => file.type.startsWith("image/"));
        if (files.length && !html.trim()) { event.preventDefault(); void insertImageFiles(files); return true; }
        // 编辑器内部复制粘贴（带 ProseMirror 切片标记）保持原生行为，图片块等节点不经转换。
        if (html.includes("data-pm-slice")) return false;
        // 网页/公众号/Word 的 HTML 在编辑器过滤前交给引擎转换：保留原件、生成导入报告。
        if (html.trim() && /<(p|div|section|h[1-6]|ul|ol|table|img|blockquote|pre|span|strong|b|em|br)\b/i.test(html)) {
          event.preventDefault(); void convertPaste(html, "adapt"); return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event.dataTransfer?.files ?? []) as ArrayLike<File>).filter((file: File) => file.type.startsWith("image/"));
        if (!files.length) return false;
        event.preventDefault(); void insertImageFiles(files); return true;
      },
    },
    onUpdate: () => schedule(),
  });
  React.useEffect(() => { editorRef.current = editor; }, [editor]);
  React.useEffect(() => {
    imageActions.current = { pickImage: pickDocumentImage };
    return () => { imageActions.current = null; };
  }, []);

  const updateStyle = (patch: Partial<DocStyle>) => {
    const next = { ...styleRef.current, ...patch };
    styleRef.current = next; setStyle(next); schedule();
  };

  const toggleTextOnly = async () => {
    if (!paste || !editor) return;
    if (paste.seq !== sequence.current) { toast.info({ title: "粘贴后已有新修改", detail: "请用撤销（Ctrl+Z）回到粘贴前再切换。" }); return; }
    editor.commands.undo();
    await convertPaste(paste.html, paste.mode === "adapt" ? "text" : "adapt");
  };

  const commitVersion = async (note: string) => {
    window.clearTimeout(timer.current);
    await saveNow();
    if (dirtyStore.isDirty(dirtyKey)) throw new Error("工作副本还没有保存成功");
    const result = await docRpc<{ version_id: string; created: boolean }>("documents.commit_version",
      { document_id: documentId, base_revision: revision.current, note });
    setUnversioned(false);
    void invalidateDocuments(account);
    return result;
  };

  const resolveConflict = async (choice: "mine" | "theirs-keep-mine") => {
    if (!conflict) return;
    if (choice === "mine") {
      revision.current = conflict.server.revision;
      await saveNow(true).catch(() => undefined);
      return;
    }
    const mine = content();
    try {
      const copy = await docRpc<DocumentDetail>("documents.create", { kind: "blank", title: titleRef.current + "（冲突副本）" });
      if (mine) await docRpc("documents.save_working", { document_id: copy.document_id, content: mine, base_revision: copy.revision });
      dirtyStore.markClean(dirtyKey); pendingCache.clear(account, documentId);
      toast.success({ title: "你的修改已另存为新文章", detail: "当前文章已载入另一处保存的版本。" });
      void invalidateDocuments(account);
      onReload();
    } catch (error) { toast.error({ title: "另存失败", detail: (error as Error).message }); }
  };

  const recover = () => {
    if (!recovery || !editor) return;
    editor.commands.setContent(recovery.content.doc);
    styleRef.current = { ...DEFAULT_STYLE, ...recovery.content.style }; setStyle(styleRef.current);
    titleRef.current = recovery.title; setTitle(recovery.title);
    // 修订不匹配的缓存也可找回，但须进入冲突处理，不能覆盖他处的新稿。
    revision.current = recovery.base_revision;
    setRecovery(null); schedule();
  };

  const statusText = saveState === "saving" ? "正在保存…" : saveState === "dirty" ? "有修改，即将自动保存"
    : saveState === "error" ? "保存失败" : saveState === "conflict" ? "存在版本冲突"
    : `已保存 ${formatTime(savedAt)}${unversioned ? " · 尚未存为版本" : ""}`;

  return (
    <div className="ice-doc-layout" style={{
      ["--doc-font-size" as string]: style.fontSize + "px", ["--doc-line-height" as string]: String(style.lineHeight),
      ["--doc-gap" as string]: style.paragraphSpacing + "px", ["--doc-brand" as string]: style.brandColor }}>
      <div className="ice-doc-main">
        <div className="ice-doc-topbar">
          <Button variant="ghost" size="sm" onClick={() => {
            void flushAllDirty().then(() => documentStore.set(null))
              .catch(error => toast.error({ title: "无法离开当前文章", detail: (error as Error).message }));
          }} aria-label="返回文章列表">← 文章</Button>
          <span className={"ice-doc-status ice-doc-status--" + saveState} role="status" aria-live="polite">{statusText}{dirty && saveState === "saved" ? "" : ""}</span>
          <span style={{ flex: 1 }} />
          {initial.series && <span className="ice-doc-chip">{initial.series}{initial.episode ? ` · 第${initial.episode}期` : ""}</span>}
          <Button size="sm" variant={panel === "style" ? "primary" : "secondary"} onClick={() => setPanel(panel === "style" ? null : "style")}>排版</Button>
          <Button size="sm" variant={panel === "versions" ? "primary" : "secondary"} onClick={() => setPanel(panel === "versions" ? null : "versions")}>版本</Button>
          <Button size="sm" variant={panel === "delivery" ? "primary" : "secondary"} onClick={() => setPanel(panel === "delivery" ? null : "delivery")}>交付与发布</Button>
        </div>
        {initial.origin === "legacy_job" && <Banner tone="info" title="从旧制作任务接入的独立文章">
          原任务、审批、运行记录保持只读；这里的修改只属于这篇文章。代码执行已在 v3 退场，历史运行输出在交付时省略。</Banner>}
        {initial.imports.length > 0 && <Banner tone="info" title="导入报告与原件已保存" actions={
          <Button size="sm" onClick={() => setPanel("versions")}>查看导入报告与原件</Button>}>
          可查看缺图、未支持模块和原始内容；按原件重新转换前会保留当前版本。
        </Banner>}
        {initial.generation_state === "failed" && <Banner tone="warning" title="AI 初稿没有完成">
          {String(initial.meta.error ?? "生成失败")}。这篇文章仍是空白稿，可以手动写，或回到首页重新起草。</Banner>}
        {recovery && <Banner tone="warning" title="发现尚未保存的本地修改" actions={<>
          <Button size="sm" variant="primary" onClick={recover}>恢复这些修改</Button>
          <Button size="sm" variant="ghost" onClick={() => { pendingCache.clear(account, documentId); setRecovery(null); }}>丢弃</Button></>}>
          记录于 {new Date(recovery.at).toLocaleString()}，可能是上次异常退出时留下的。</Banner>}
        {conflict && <Banner tone="danger" title="版本冲突：这篇文章在别处被保存过" actions={<>
          <Button size="sm" variant="primary" onClick={() => void resolveConflict("mine")}>用我的修改覆盖</Button>
          <Button size="sm" onClick={() => void resolveConflict("theirs-keep-mine")}>我的修改另存为新文章</Button></>}>
          另一处保存于 {formatTime(conflict.server.updated_at)}。你的修改仍保留在编辑器中，不会丢失。</Banner>}
        {saveState === "error" && saveError != null && <ErrorNote error={saveError} note="修改仍在编辑器和本地恢复缓存中。"
          onRetry={() => void saveNow().catch(() => undefined)} retryLabel="重试保存" />}
        <Toolbar editor={editor} style={style} onImage={async () => {
          const image = await pickDocumentImage();
          if (image) editor?.chain().focus().insertContent({ type: "articleImage", attrs: { resourceId: image.resource_id, caption: "", width: 100, align: "center" } }).run();
        }} />
        <AnimatePresence>{(paste || pasting) && <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          <PasteReportBar state={paste} busy={pasting} onToggle={() => void toggleTextOnly()} onClose={() => setPaste(null)} />
        </motion.div>}</AnimatePresence>
        <div className="ice-doc-scroll">
          <div className="ice-doc-paper">
            <input className="ice-doc-title" value={title} placeholder="文章标题" maxLength={300} aria-label="文章标题"
                   onChange={event => { titleRef.current = event.target.value; setTitle(event.target.value); schedule(); }} />
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
      <AnimatePresence>{panel && <motion.aside className="ice-doc-side" key="side"
        initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.18 }}>
        <DocumentSidePanel panel={panel} onPanel={setPanel} documentId={documentId} style={style} onStyle={updateStyle}
          revision={getRevision} flush={flush}
          commitVersion={commitVersion} unversioned={unversioned} onRestored={onReload} detail={initial} />
      </motion.aside>}</AnimatePresence>
    </div>
  );
}

function PasteReportBar({ state, busy, onToggle, onClose }: { state: PasteState; busy: boolean; onToggle: () => void; onClose: () => void }) {
  const [open, setOpen] = React.useState(false);
  if (!state) return <div className="ice-doc-report"><Spinner size={12} /> 正在转换粘贴内容…</div>;
  const r = state.report;
  const missing = r.images.missing.length, islands = r.islands.length;
  const dropped = Object.entries(r.dropped).filter(([key]) => !["meta", "link", "head", "title"].includes(key));
  return (
    <div className={"ice-doc-report" + (missing || islands ? " is-warning" : "")} role="status">
      <strong>{state.mode === "adapt" ? "已按当前样式粘贴" : "已仅保留文字"}</strong>
      <span>{r.paragraphs} 段 · {r.headings} 个标题 · 图片 {r.images.imported}/{r.images.total}</span>
      {missing > 0 && <span className="is-warn">{missing} 张图片需要替换</span>}
      {islands > 0 && <span className="is-warn">{islands} 个未支持模块保留为只读原件</span>}
      <span style={{ flex: 1 }} />
      <button type="button" className="ice-link-btn" onClick={() => setOpen(value => !value)}>{open ? "收起报告" : "查看报告"}</button>
      <Button size="sm" loading={busy} onClick={onToggle}>{state.mode === "adapt" ? "改为仅保留文字" : "恢复适配样式"}</Button>
      <button type="button" className="ice-link-btn" onClick={onClose} aria-label="关闭导入报告">关闭</button>
      {open && <div className="ice-doc-report__detail">
        {r.images.missing.map((item, index) => <div key={index}>缺图：{item.alt || "未命名"} — {item.reason}{item.src && item.src !== "data:…" ? `（${item.src}）` : ""}</div>)}
        {r.islands.map((item, index) => <div key={"i" + index}>原件：{item.reason}「{item.preview.slice(0, 40)}」</div>)}
        {Object.keys(r.styles.ignored).length > 0 && <div>未映射样式：{Object.entries(r.styles.ignored).map(([k, v]) => `${k}×${v}`).join("、")}</div>}
        {dropped.length > 0 && <div>已移除（不安全或无法交付）：{dropped.map(([k, v]) => `${k}×${v}`).join("、")}</div>}
        <div className="ice-doc-muted">原始粘贴内容已留档；切换模式可用 Ctrl+Z 撤销。</div>
      </div>}
    </div>
  );
}

function Toolbar({ editor, style, onImage }: { editor: Editor | null; style: DocStyle; onImage: () => void }) {
  const [, force] = React.useReducer((value: number) => value + 1, 0);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [href, setHref] = React.useState("");
  React.useEffect(() => {
    if (!editor) return;
    editor.on("selectionUpdate", force); editor.on("transaction", force);
    return () => { editor.off("selectionUpdate", force); editor.off("transaction", force); };
  }, [editor]);
  if (!editor) return <div className="ice-doc-toolbar" />;
  const chain = () => editor.chain().focus();
  const block = editor.isActive("heading", { level: 1 }) ? "h1" : editor.isActive("heading", { level: 2 }) ? "h2"
    : editor.isActive("heading", { level: 3 }) ? "h3" : "p";
  const align = (editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph").textAlign as string | null) ?? "left";
  const textStyle = editor.getAttributes("textStyle") as { color?: string | null; fontSize?: string | null };
  const setTextStyle = (patch: { color?: string | null; fontSize?: string | null }) => {
    const next = { color: textStyle.color ?? null, fontSize: textStyle.fontSize ?? null, ...patch };
    if (!next.color && !next.fontSize) chain().unsetMark("textStyle").run();
    else chain().setMark("textStyle", next).run();
  };
  const setAlign = (value: string) => {
    const textAlign = value === "left" ? null : value;
    chain().updateAttributes("paragraph", { textAlign }).updateAttributes("heading", { textAlign }).run();
  };
  const T = ({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) =>
    <button type="button" className={"ice-doc-tool" + (active ? " is-active" : "")} aria-label={label} title={label}
            aria-pressed={active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>;
  return (
    <div className="ice-doc-toolbar" role="toolbar" aria-label="正文格式">
      <select aria-label="段落类型" value={block} onChange={event => {
        const value = event.target.value;
        if (value === "p") chain().setParagraph().run();
        else chain().setHeading({ level: Number(value[1]) as 1 | 2 | 3 }).run();
      }}>
        <option value="p">正文</option><option value="h1">大标题</option><option value="h2">小标题</option><option value="h3">三级标题</option>
      </select>
      <span className="ice-doc-tool-sep" />
      <T label="加粗 (Ctrl+B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}><b>B</b></T>
      <T label="斜体 (Ctrl+I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}><i>I</i></T>
      <T label="下划线 (Ctrl+U)" active={editor.isActive("underline")} onClick={() => chain().toggleUnderline().run()}><u>U</u></T>
      <T label="删除线" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}><s>S</s></T>
      <T label="行内代码" active={editor.isActive("code")} onClick={() => chain().toggleCode().run()}>{"<>"}</T>
      <span className="ice-doc-tool-sep" />
      <details className="ice-doc-pop">
        <summary className="ice-doc-tool" title="文字颜色" aria-label="文字颜色"><span style={{ borderBottom: `3px solid ${textStyle.color || "currentColor"}` }}>A</span></summary>
        <div className="ice-doc-pop__panel">
          <div className="ice-doc-swatches">
            {[...new Set([style.brandColor, ...COLORS])].map(color => <button key={color} type="button" style={{ background: color }} aria-label={"颜色 " + color}
              onMouseDown={event => event.preventDefault()} onClick={() => setTextStyle({ color })} />)}
          </div>
          <button type="button" className="ice-link-btn" onMouseDown={event => event.preventDefault()} onClick={() => setTextStyle({ color: null })}>恢复默认颜色</button>
        </div>
      </details>
      <select aria-label="局部字号" value={textStyle.fontSize ?? ""} onChange={event => setTextStyle({ fontSize: event.target.value || null })}>
        <option value="">字号</option>{INLINE_FONT_SIZES.map(size => <option key={size} value={size}>{size.replace("px", "")}</option>)}
      </select>
      <span className="ice-doc-tool-sep" />
      {(["left", "center", "right", "justify"] as const).map(value =>
        <T key={value} label={{ left: "左对齐", center: "居中", right: "右对齐", justify: "两端对齐" }[value]} active={align === value}
           onClick={() => setAlign(value)}>{{ left: "⇤", center: "≡", right: "⇥", justify: "☰" }[value]}</T>)}
      <span className="ice-doc-tool-sep" />
      <T label="无序列表" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>•</T>
      <T label="有序列表" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>1.</T>
      <T label="引用" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}>❝</T>
      <T label="代码块" active={editor.isActive("codeBlock")} onClick={() => chain().toggleCodeBlock().run()}>{"{ }"}</T>
      <T label="分隔线" onClick={() => chain().setHorizontalRule().run()}>—</T>
      <span className="ice-doc-tool-sep" />
      <T label="链接" active={editor.isActive("link")} onClick={() => { setHref(String(editor.getAttributes("link").href ?? "")); setLinkOpen(value => !value); }}>🔗</T>
      <T label="插入图片" onClick={onImage}>图片</T>
      <span className="ice-doc-tool-sep" />
      <T label="撤销 (Ctrl+Z)" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>↶</T>
      <T label="重做 (Ctrl+Shift+Z)" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>↷</T>
      {linkOpen && <form className="ice-doc-linkform" onSubmit={event => {
        event.preventDefault();
        const value = href.trim();
        if (!value) chain().extendMarkRange("link").unsetLink().run();
        else chain().extendMarkRange("link").setLink({ href: /^(https?:|mailto:)/i.test(value) ? value : "https://" + value }).run();
        setLinkOpen(false);
      }}>
        <Input autoFocus value={href} placeholder="https://" aria-label="链接地址" onChange={event => setHref(event.target.value)} />
        <Button size="sm" type="submit" variant="primary">确定</Button>
        <Button size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>取消</Button>
      </form>}
    </div>
  );
}
