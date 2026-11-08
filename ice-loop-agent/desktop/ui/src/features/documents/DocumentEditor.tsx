// v3 普通文章编辑器（A-02/A-03/B-01/B-02/B-03）：不需要 jobId、模型、栏目或期号。
// 保存链：输入 → 本地恢复缓存 → 800ms 写工作副本（revision 乐观并发）→ 显式/交付时冻结为版本。
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, ErrorPanel, Input, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { accountStore, dirtyStore, flushAllDirty, queryClient, registerDirtyFlush, useCurrentAccount } from "../../data/client";
import { conversationStore } from "../../data/client";
import { documentEditingStore, documentPanelStore, documentStore, setWorkspace } from "../../app/uiState";
import {
  AUTHOR_LIMIT, DEFAULT_STYLE, HIGHLIGHTS, INLINE_FONT_SIZES, LETTER_SPACINGS, LINE_HEIGHTS, PARAGRAPH_SPACINGS, SUMMARY_LIMIT, TITLE_LIMIT,
  docRpc, formatTime, invalidateDocuments, pendingCache,
  type AssistApplied, type DocContent, type DocInfo, type DocStyle, type DocumentDetail, type ImageView, type ImportReport, type SaveResult,
} from "./documentsApi";
import { ArticleImage, BlockId, Callout, DocImageSlot, DocRawBlock, DocRunOutput, ImageGroup, RawHtml, TextAlign, TextStyle, imageActions } from "./docExtensions";
import { DocumentSidePanel } from "./DocumentSidePanel";
import { MaterialLibrary } from "./MaterialLibrary";
import { trashDocument } from "./documentDelete";
import { DocumentSkillChip, type SkillBinding } from "./DocumentSkills";
import { docPerf } from "./docPerf";
import type { AssistBridge } from "./DocumentAssistPanel";
import "../../styles/documents.css";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type Conflict = Extract<SaveResult, { conflict: true }>;
type PasteState = { html: string; mode: "adapt" | "text"; report: ImportReport; seq: number } | null;

const ASSIST_EDITABLE = new Set(["paragraph", "heading", "bulletList", "orderedList", "blockquote"]);
const COLORS = ["#111827", "#6b7280", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777"];

/** 选图导入：显式带上发起时的公众号，选择框打开期间切号也不会导入到新公众号。 */
export async function pickDocumentImage(accountId = accountStore.get()): Promise<ImageView | null> {
  const pick = window.ice?.pickDocumentImage as undefined | ((accountId: string) => Promise<ImageView | null>);
  if (typeof pick !== "function") { toast.warning({ title: "请在桌面应用中插入图片", detail: "也可以直接粘贴或拖入图片。" }); return null; }
  try { return await pick(accountId); }
  catch (error) { if (accountStore.get() === accountId) toast.error({ title: "图片没有导入", detail: (error as Error).message }); return null; }
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
  // v3.12 性能读数：每次打开（换文章/换号）重新计时；生成中轮询与重新载入不重置。
  React.useEffect(() => { docPerf.open(documentId); }, [documentId, account]);
  React.useEffect(() => {
    let active = true;
    setLoadError(null);
    docRpc<DocumentDetail>("documents.get", { document_id: documentId })
      .then(value => { if (active) { docPerf.loaded(documentId); setData(value); } })
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
  const [title, setTitle] = React.useState(initial.title);
  const [style, setStyle] = React.useState<DocStyle>({ ...DEFAULT_STYLE, ...initial.content.style });
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const [savedAt, setSavedAt] = React.useState(initial.working_updated_at);
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const [unversioned, setUnversioned] = React.useState(initial.unversioned_changes);
  const [panel, setPanel] = React.useState<"assist" | "compare" | "compat" | "perf" | "style" | "versions" | "delivery" | null>(null);
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
  // v3.2：文章设置（作者/摘要/原文链接/封面）随正文一起保存为同一份规范值。
  const [info, setInfo] = React.useState<DocInfo>(() => ({ ...(initial.content.info ?? {}) }));
  const infoRef = React.useRef(info);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const svgInput = React.useRef<HTMLInputElement | null>(null);
  const [words, setWords] = React.useState(0);
  const editorRef = React.useRef<Editor | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const content = React.useCallback((): DocContent | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const value: DocContent = { schema: 1, doc: editor.getJSON() as DocContent["doc"], style: styleRef.current };
    const meta = Object.fromEntries(Object.entries(infoRef.current).filter(([, v]) => typeof v === "string" && v.trim())) as DocInfo;
    if (Object.keys(meta).length) value.info = meta;
    return value;
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
        const started = performance.now();
        const result = await docRpc<SaveResult>("documents.save_working", {
          account_id: account, document_id: documentId, content: value, base_revision: revision.current, title: titleRef.current, force,
        });
        docPerf.saved(documentId, performance.now() - started);
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

  // v3.11 异步边界：记下发起时的编辑器与公众号；等待（选文件、渲染、RPC）结束后仍是同一篇、同一号才写回正文。
  // 已发出的请求不伪称取消：资源仍保存在原公众号素材库，只是不再插回已离开的正文。
  const captureTarget = React.useCallback(() => {
    const target = editorRef.current;
    return { target, account, active: () => Boolean(target) && mounted.current && accountStore.get() === account
      && !target!.isDestroyed && editorRef.current === target };
  }, [account]);
  const insertImageFiles = React.useCallback(async (files: File[]) => {
    const target = editorRef.current;
    if (!target) return;
    const active = () => mounted.current && accountStore.get() === account
      && !target.isDestroyed && editorRef.current === target;
    for (const file of files.slice(0, 20)) {
      if (!active()) return;
      try {
        const dataUrl = await readAsDataURL(file);
        if (!active()) return;
        const image = await docRpc<ImageView>("documents.image_import_data", { account_id: account, data_url: dataUrl, name: file.name.replace(/\.[^.]+$/, "") });
        // 已发出的请求可能在离开后完成；资源仍归原公众号，但不能写回已离开的正文。
        if (!active()) return;
        target.chain().focus().insertContent({ type: "articleImage", attrs: { resourceId: image.resource_id, caption: "", width: 100, align: "center" } }).run();
      } catch (error) { if (active()) toast.error({ title: `「${file.name}」没有导入`, detail: (error as Error).message }); }
    }
  }, [account]);

  const convertPaste = React.useCallback(async (html: string, mode: "adapt" | "text") => {
    const { target, active } = captureTarget();
    setPasting(true);
    try {
      const result = await docRpc<{ content: DocContent; report: ImportReport }>("documents.convert_paste",
        { account_id: account, html, mode, style: styleRef.current, document_id: documentId });
      if (!active()) return;
      target!.chain().focus().insertContent(result.content.doc.content ?? []).run();
      setPaste({ html, mode, report: result.report, seq: sequence.current });
    } catch (error) { if (active()) toast.error({ title: "粘贴内容没有转换", detail: (error as Error).message }); }
    finally { if (mounted.current) setPasting(false); }
  }, [account, captureTarget, documentId]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["https", "http", "mailto"] } }),
      BlockId, TextAlign, TextStyle, ArticleImage, RawHtml, DocImageSlot, DocRunOutput, DocRawBlock, Callout, ImageGroup,
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
  // 正文字数（与公众号底栏一致：不计空白）。
  React.useEffect(() => {
    if (!editor) return;
    const count = () => setWords(editor.state.doc.textContent.replace(/\s+/g, "").length);
    count(); editor.on("update", count);
    return () => { editor.off("update", count); };
  }, [editor]);
  React.useEffect(() => { editorRef.current = editor; }, [editor]);
  // v3.12 性能读数：编辑器首次可输入、按键到下一帧的输入响应。
  React.useEffect(() => {
    if (!editor) return;
    docPerf.editable(documentId);
    const dom = editor.view.dom as HTMLElement;
    const onKey = () => docPerf.keystroke(documentId);
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor, documentId]);
  React.useEffect(() => {
    imageActions.current = { pickImage: pickDocumentImage };
    return () => { imageActions.current = null; };
  }, []);

  const updateStyle = (patch: Partial<DocStyle>) => {
    const next = { ...styleRef.current, ...patch };
    styleRef.current = next; setStyle(next); schedule();
  };
  const updateInfo = (patch: Partial<DocInfo>) => {
    const next = { ...infoRef.current, ...patch };
    infoRef.current = next; setInfo(next); schedule();
  };
  const insertImage = async () => {
    const { target, account: owner, active } = captureTarget();
    const image = await pickDocumentImage(owner);
    if (image && active()) target!.chain().focus().insertContent({ type: "articleImage", attrs: { resourceId: image.resource_id, caption: "", width: 100, align: "center" } }).run();
  };
  const insertSlot = () => {
    let count = 0;
    editor?.state.doc.descendants(node => { if (node.type.name === "imageSlot" || node.type.name === "articleImage") count += 1; return true; });
    editor?.chain().focus().insertContent({ type: "imageSlot", attrs: { figureNo: count + 1, caption: "待配图", kind: "生图", obtain: "见配图方案表" } }).run();
  };
  // P2 组件：提示卡片包住当前段落（空段落时插入新卡片）；多图先选两张。
  const insertCallout = () => {
    if (!editor) return;
    const { $from } = editor.state.selection;
    const parent = $from.depth >= 1 ? $from.node(1) : null;
    if (parent && parent.type.name === "paragraph" && parent.textContent.trim()) {
      editor.chain().focus().wrapIn("callout", { tone: "brand", title: "" }).run();
    } else {
      editor.chain().focus().insertContent({ type: "callout", attrs: { tone: "brand", title: "" }, content: [{ type: "paragraph" }] }).run();
    }
  };
  // P2 SVG：在桌面主进程里以 <img> 渲染为 PNG（不执行 SVG 内脚本），正文插入位图，原 SVG 另存。
  const insertSvg = async (file: File) => {
    const render = window.ice?.documentSvgImage as undefined | ((params: Record<string, unknown>) => Promise<ImageView>);
    if (typeof render !== "function") { toast.warning({ title: "请在桌面应用中插入 SVG" }); return; }
    if (file.size > 2 * 1024 * 1024) { toast.warning({ title: "SVG 文件需小于 2MB" }); return; }
    const { target, account: owner, active } = captureTarget();
    try {
      const image = await render({ account_id: owner, svg: await file.text(), name: file.name.replace(/\.svg$/i, ""), width: 1080 });
      if (!active()) return;
      target!.chain().focus().insertContent({ type: "articleImage", attrs: { resourceId: image.resource_id, caption: "", width: 100, align: "center" } }).run();
      toast.success({ title: "SVG 已转为图片插入", detail: `${image.width}×${image.height}；动画与交互不会保留。` });
    } catch (error) { if (active()) toast.error({ title: "SVG 没有插入", detail: (error as Error).message }); }
  };
  const insertGroup = async () => {
    const { target, account: owner, active } = captureTarget();
    const first = await pickDocumentImage(owner);
    if (!first || !active()) return;
    const second = await pickDocumentImage(owner);
    if (!active()) return;
    if (!second) { toast.info({ title: "多图需要至少 2 张", detail: "已取消；单张图片请用“图片”。" }); return; }
    target!.chain().focus().insertContent({ type: "imageGroup", attrs: { columns: 2, caption: "",
      images: [{ resourceId: first.resource_id, caption: "" }, { resourceId: second.resource_id, caption: "" }] } }).run();
  };
  const saveVersion = async () => {
    try {
      const result = await commitVersion("");
      toast.success({ title: result.created ? "已保存为新版本" : "内容与最新版本相同，未重复保存" });
    } catch (error) { toast.error({ title: "版本没有保存", detail: (error as Error).message }); }
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
    infoRef.current = { ...(recovery.content.info ?? {}) }; setInfo(infoRef.current);
    titleRef.current = recovery.title; setTitle(recovery.title);
    // 修订不匹配的缓存也可找回，但须进入冲突处理，不能覆盖他处的新稿。
    revision.current = recovery.base_revision;
    setRecovery(null); schedule();
  };

  const statusText = saveState === "saving" ? "正在保存…" : saveState === "dirty" ? "有修改，即将自动保存"
    : saveState === "error" ? "保存失败" : saveState === "conflict" ? "存在版本冲突"
    : `已保存 ${formatTime(savedAt)}`;
  const leave = () => {
    void flushAllDirty().then(() => documentStore.set(null))
      .catch(error => toast.error({ title: "无法离开当前文章", detail: (error as Error).message }));
  };
  const [trashing, setTrashing] = React.useState(false);
  const trash = async () => {
    setTrashing(true);
    try { await trashDocument(documentId, titleRef.current); }
    catch (error) { toast.error({ title: "没有移入回收站", detail: (error as Error).message }); }
    finally { if (mounted.current) setTrashing(false); }
  };
  const togglePanel = (value: "assist" | "compare" | "compat" | "perf" | "style" | "versions" | "delivery") => setPanel(panel === value ? null : value);
  // v3.8：把保存状态告诉左栏“正在编辑”卡片；左栏请求打开侧栏时响应。
  React.useEffect(() => {
    documentEditingStore.set({ documentId, title, saveState, savedAt, unversioned, words });
  }, [documentId, title, saveState, savedAt, unversioned, words]);
  React.useEffect(() => () => { if (documentEditingStore.get()?.documentId === documentId) documentEditingStore.set(null); }, [documentId]);
  React.useEffect(() => {
    // 请求可能早于编辑器载入（从列表“去处理”打开文章时），挂载时也检查一次。
    const take = () => {
      const request = documentPanelStore.get();
      if (request && Date.now() - request.at < 10_000) { setPanel(request.panel); documentPanelStore.set(null); }
    };
    take();
    return documentPanelStore.subscribe(take);
  }, []);

  // P1-01：给助手的编辑器接口。采纳结果整体替换正文为“一个事务”，Ctrl+Z 一步撤销。
  const assistBridge = React.useMemo<AssistBridge>(() => ({
    selection: () => {
      const ed = editorRef.current;
      if (!ed) return [];
      const { from, to } = ed.state.selection;
      const ids: string[] = [];
      ed.state.doc.forEach((node: any, offset: number) => {
        const end = offset + node.nodeSize;
        const hit = from === to ? from > offset && from < end : end > from && offset < to;
        if (hit && ASSIST_EDITABLE.has(node.type.name) && node.attrs.id && node.textContent.trim()) ids.push(node.attrs.id);
      });
      return ids;
    },
    blockText: id => {
      const ed = editorRef.current;
      let found: string | null = null;
      ed?.state.doc.forEach((node: any) => { if (node.attrs.id === id) found = node.textContent; });
      return found;
    },
    matchesBlock: (id, before) => {
      const ed = editorRef.current;
      if (!ed) return false;
      try {
        const expected = ed.schema.nodeFromJSON(before);
        let matches = false;
        ed.state.doc.forEach(node => { if (node.attrs.id === id) matches = node.eq(expected); });
        return matches;
      } catch { return false; }
    },
    focusBlock: id => {
      const ed = editorRef.current;
      if (!ed) return;
      let at = -1, inner = -1;
      ed.state.doc.forEach((node: any, offset: number) => {
        if (node.attrs.id !== id) return;
        at = offset;
        if (node.isTextblock) inner = offset + 1;
        // 列表/引用：光标放进第一个文字块，避免落在容器节点之间。
        else node.descendants((child: any, pos: number) => {
          if (inner >= 0) return false;
          if (child.isTextblock) { inner = offset + 1 + pos + 1; return false; }
          return true;
        });
      });
      if (at < 0) { toast.info({ title: "这一段已经不在正文里了" }); return; }
      const chain = ed.chain().focus();
      (inner >= 0 ? chain.setTextSelection(inner) : chain.setNodeSelection(at)).scrollIntoView().run();
    },
    apply: (result: AssistApplied) => {
      const ed = editorRef.current;
      // 采纳/撤销请求返回时已离开这篇文章：服务端已保存，重新打开即可看到，不写入其他正文。
      if (!ed || ed.isDestroyed || !mounted.current || accountStore.get() !== account) return;
      // 先更新修订号：随后的自动保存以服务端结果为基准（内容相同 → unchanged）。
      revision.current = result.revision;
      const next = ed.schema.nodeFromJSON(result.content.doc);
      ed.view.dispatch(ed.state.tr.replaceWith(0, ed.state.doc.content.size, next.content).setMeta("ice-assist", true));
      if (mounted.current) { setSavedAt(result.saved_at); setUnversioned(false); }
      void invalidateDocuments(account);
      void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.versions"] });
    },
    lock: locked => { const ed = editorRef.current; if (ed && !ed.isDestroyed) ed.setEditable(!locked, false); },
    subscribe: listener => {
      const ed = editorRef.current;
      if (!ed) return () => undefined;
      ed.on("selectionUpdate", listener); ed.on("update", listener);
      return () => { ed.off("selectionUpdate", listener); ed.off("update", listener); };
    },
  }), [account, editor]);

  return (
    <div className="ice-doc-layout" data-theme={style.theme ?? "clean"} style={{
      ["--doc-font-size" as string]: style.fontSize + "px", ["--doc-line-height" as string]: String(style.lineHeight),
      ["--doc-gap" as string]: style.paragraphSpacing + "px", ["--doc-brand" as string]: style.brandColor,
      ["--doc-letter" as string]: (style.letterSpacing ?? 0.5) + "px" }}>
      <div className="ice-doc-main">
        {/* v3.2：参照公众号编辑页——第一行“插入”，第二行“格式”。 */}
        <div className="ice-doc-insertbar" role="toolbar" aria-label="插入">
          <Button variant="ghost" size="sm" onClick={leave} aria-label="返回文章列表">← 文章</Button>
          <span style={{ flex: 1 }} />
          <div className="ice-doc-insertgrp">
            <button type="button" onClick={() => void insertImage()} title="插入本地图片（也可直接粘贴或拖入）">图片</button>
            <button type="button" onClick={() => setLibraryOpen(true)} title="从当前公众号导入过的图片中选择，可按标签筛选">素材库</button>
            <button type="button" onClick={() => svgInput.current?.click()} title="把 SVG 文件渲染成图片插入（公众号兼容；原 SVG 留存）">SVG</button>
            <input ref={svgInput} type="file" accept=".svg,image/svg+xml" hidden aria-label="选择 SVG 文件"
                   onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void insertSvg(file); }} />
            <button type="button" onClick={() => document.dispatchEvent(new CustomEvent("ice-doc-link"))} title="给选中文字添加链接">超链接</button>
            <button type="button" onClick={() => editor?.chain().focus().toggleBlockquote().run()}>引用</button>
            <button type="button" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>分隔线</button>
            <button type="button" onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>代码块</button>
            <button type="button" onClick={insertSlot} title="先占位，稍后插入实际图片；交付前必须补齐">待配图位</button>
            <button type="button" onClick={insertCallout} title="带底色的提示卡片，可写标题、段落和列表">提示卡片</button>
            <button type="button" onClick={() => void insertGroup()} title="2–9 张图片按 2 列或 3 列并排">多图</button>
          </div>
          <span style={{ flex: 1 }} />
          {initial.series && <span className="ice-doc-chip">{initial.series}{initial.episode ? ` · 第${initial.episode}期` : ""}</span>}
          <DocumentSkillChip documentId={documentId} binding={(initial.meta.skill_binding as SkillBinding | undefined) ?? null}
                             generated={initial.meta.generated_skills as Array<{ name: string; version?: number | null; kind: string }> | undefined} />
          <Button variant="ghost" size="sm" className="ice-doc-danger-text" loading={trashing} disabled={initial.generation_state === "running"}
                  title="先保存，再把这篇文章移入回收站；可在提示里撤销，或到文章首页的回收站恢复" onClick={() => void trash()}>删除</Button>
        </div>
        {initial.origin === "legacy_job" && <Banner tone="info" title="从旧制作任务接入的独立文章">
          原任务、审批、运行记录保持只读；这里的修改只属于这篇文章。代码执行已在 v3 退场，历史运行输出在交付时省略。</Banner>}
        {initial.imports.length > 0 && <Banner tone="info" title="导入报告与原件已保存" actions={
          <Button size="sm" onClick={() => setPanel("versions")}>查看导入报告与原件</Button>}>
          可查看缺图、未支持模块和原始内容；按原件重新转换前会保留当前版本。
        </Banner>}
        {Boolean(initial.meta.compat_sample) && <Banner tone="info" title="微信兼容测试稿" actions={
          <Button size="sm" onClick={() => setPanel("compat")}>打开兼容记录</Button>}>
          复制到公众号后台后，按每组前的【编号】在“兼容记录”里分阶段记录：粘贴后、后台保存后、手机预览。</Banner>}
        {Boolean(initial.meta.variant_group && initial.meta.variant) && <Banner tone="info" title={`AI 初稿 · 版本 ${String(initial.meta.variant)}`} actions={
          <Button size="sm" onClick={() => setPanel("compare")}>对照另一版</Button>}>
          同一需求生成了两个不同角度的版本，各自是独立文章。可以并排对照，保留一版后把另一版移入回收站。</Banner>}
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
        <Toolbar editor={editor} style={style} onStyle={updateStyle} />
        <AnimatePresence>{(paste || pasting) && <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          <PasteReportBar state={paste} busy={pasting} onToggle={() => void toggleTextOnly()} onClose={() => setPaste(null)} />
        </motion.div>}</AnimatePresence>
        <div className="ice-doc-scroll">
          <div className="ice-doc-paper">
            <div className="ice-doc-titlerow">
              <textarea className="ice-doc-title" value={title} placeholder="请在这里输入标题" maxLength={300} aria-label="文章标题" rows={1}
                        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); editor?.commands.focus("start"); } }}
                        onChange={event => { const value = event.target.value.replace(/\n/g, ""); titleRef.current = value; setTitle(value); schedule(); }} />
              <span className={"ice-doc-counter" + (title.length > TITLE_LIMIT ? " is-over" : "")} title={`公众号标题上限 ${TITLE_LIMIT} 字`}>{title.length}/{TITLE_LIMIT}</span>
            </div>
            <div className="ice-doc-authorrow">
              <input className="ice-doc-author" value={info.author ?? ""} placeholder="请输入作者" maxLength={20} aria-label="作者"
                     onChange={event => updateInfo({ author: event.target.value })} />
              {(info.author ?? "").length > 0 && <span className={"ice-doc-counter" + ((info.author ?? "").length > AUTHOR_LIMIT ? " is-over" : "")}>{(info.author ?? "").length}/{AUTHOR_LIMIT}</span>}
            </div>
            <EditorContent editor={editor} />
          </div>
        </div>
        <div className="ice-doc-fab">
          <AnimatePresence>{settingsOpen && <motion.div key="settings" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}>
            <ArticleSettings info={info} onChange={updateInfo} onClose={() => setSettingsOpen(false)} editor={editor} />
          </motion.div>}</AnimatePresence>
          <button type="button" className={"ice-doc-pill ice-doc-pill--ai" + (panel === "assist" ? " is-on" : "")} onClick={() => togglePanel("assist")}
                  title="选中段落后改写、扩写、压缩、改语气，或让助手建议配图位置；结果先作为提案，勾选后才改正文">✎ AI 助手</button>
          <button type="button" className={"ice-doc-pill" + (panel === "style" ? " is-on" : "")} onClick={() => togglePanel("style")}>✦ 一键排版</button>
          <button type="button" className={"ice-doc-pill" + (settingsOpen ? " is-on" : "")} aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen(value => !value)}>⚙ 文章设置</button>
        </div>
        <div className="ice-doc-bottombar">
          <span>正文字数 {words.toLocaleString()}</span>
          <span className={"ice-doc-status ice-doc-status--" + saveState} role="status" aria-live="polite">· {statusText}</span>
          {unversioned && saveState === "saved" && <span className="ice-doc-chip is-warn">尚未存为版本</span>}
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={() => togglePanel("versions")} aria-pressed={panel === "versions"}>历史版本</Button>
          <Button size="sm" variant="primary" onClick={() => void saveVersion()}>保存版本</Button>
          <Button size="sm" onClick={() => togglePanel("delivery")} aria-pressed={panel === "delivery"}>手机预览与交付</Button>
        </div>
      </div>
      {libraryOpen && <MaterialLibrary open onClose={() => setLibraryOpen(false)} onInsert={resourceId =>
        editor?.chain().focus().insertContent({ type: "articleImage", attrs: { resourceId, caption: "", width: 100, align: "center" } }).run()} />}
      <AnimatePresence>{panel && <motion.aside className="ice-doc-side" key="side"
        initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.18 }}>
        <DocumentSidePanel panel={panel} onPanel={setPanel} documentId={documentId} style={style} onStyle={updateStyle}
          revision={getRevision} flush={flush}
          commitVersion={commitVersion} unversioned={unversioned} onRestored={onReload} detail={initial} assist={assistBridge} />
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

function Toolbar({ editor, style, onStyle }: { editor: Editor | null; style: DocStyle; onStyle: (patch: Partial<DocStyle>) => void }) {
  const [, force] = React.useReducer((value: number) => value + 1, 0);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [href, setHref] = React.useState("");
  React.useEffect(() => {
    if (!editor) return;
    editor.on("selectionUpdate", force); editor.on("transaction", force);
    return () => { editor.off("selectionUpdate", force); editor.off("transaction", force); };
  }, [editor]);
  React.useEffect(() => {
    const open = () => { if (editor) { setHref(String(editor.getAttributes("link").href ?? "")); setLinkOpen(true); } };
    document.addEventListener("ice-doc-link", open);
    return () => document.removeEventListener("ice-doc-link", open);
  }, [editor]);
  if (!editor) return <div className="ice-doc-toolbar" />;
  const chain = () => editor.chain().focus();
  const block = editor.isActive("heading", { level: 1 }) ? "h1" : editor.isActive("heading", { level: 2 }) ? "h2"
    : editor.isActive("heading", { level: 3 }) ? "h3" : "p";
  const align = (editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph").textAlign as string | null) ?? "left";
  const indent = Boolean(editor.getAttributes("paragraph").indent);
  const textStyle = editor.getAttributes("textStyle") as { color?: string | null; fontSize?: string | null; backgroundColor?: string | null };
  const setTextStyle = (patch: { color?: string | null; fontSize?: string | null; backgroundColor?: string | null }) => {
    const next = { color: textStyle.color ?? null, fontSize: textStyle.fontSize ?? null, backgroundColor: textStyle.backgroundColor ?? null, ...patch };
    if (!next.color && !next.fontSize && !next.backgroundColor) chain().unsetMark("textStyle").run();
    else chain().setMark("textStyle", next).run();
  };
  const setAlign = (value: string) => {
    const textAlign = value === "left" ? null : value;
    chain().updateAttributes("paragraph", { textAlign }).updateAttributes("heading", { textAlign }).run();
  };
  const T = ({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) =>
    <button type="button" className={"ice-doc-tool" + (active ? " is-active" : "")} aria-label={label} title={label}
            aria-pressed={active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>;
  const Swatches = ({ colors, current, onPick, reset, label }: { colors: string[]; current?: string | null; onPick: (c: string) => void; reset: string; label: string }) => (
    <div className="ice-doc-pop__panel">
      <div className="ice-doc-swatches">
        {colors.map(color => <button key={color} type="button" style={{ background: color }} aria-label={label + " " + color} aria-pressed={current === color}
          onMouseDown={event => event.preventDefault()} onClick={() => onPick(color)} />)}
      </div>
      <button type="button" className="ice-link-btn" onMouseDown={event => event.preventDefault()} onClick={() => onPick("")}>{reset}</button>
    </div>
  );
  return (
    <div className="ice-doc-toolbar" role="toolbar" aria-label="正文格式">
      <T label="撤销 (Ctrl+Z)" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>↶</T>
      <T label="重做 (Ctrl+Shift+Z)" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>↷</T>
      <T label="清除格式" onClick={() => chain().unsetAllMarks().updateAttributes("paragraph", { textAlign: null, indent: null }).run()}>⌫</T>
      <span className="ice-doc-tool-sep" />
      <select aria-label="段落类型" value={block} onChange={event => {
        const value = event.target.value;
        if (value === "p") chain().setParagraph().run();
        else chain().setHeading({ level: Number(value[1]) as 1 | 2 | 3 }).run();
      }}>
        <option value="p">正文</option><option value="h1">大标题</option><option value="h2">小标题</option><option value="h3">三级标题</option>
      </select>
      <select aria-label="选中文字字号" title="选中文字的字号；全文字号在“一键排版”中设置" value={textStyle.fontSize ?? ""}
              onChange={event => setTextStyle({ fontSize: event.target.value || null })}>
        <option value="">{style.fontSize}px</option>{INLINE_FONT_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
      </select>
      <span className="ice-doc-tool-sep" />
      <T label="加粗 (Ctrl+B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}><b>B</b></T>
      <T label="斜体 (Ctrl+I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}><i>I</i></T>
      <T label="下划线 (Ctrl+U)" active={editor.isActive("underline")} onClick={() => chain().toggleUnderline().run()}><u>U</u></T>
      <T label="删除线" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}><s>S</s></T>
      <details className="ice-doc-pop">
        <summary className="ice-doc-tool" title="文字颜色" aria-label="文字颜色"><span style={{ borderBottom: `3px solid ${textStyle.color || "currentColor"}` }}>A</span></summary>
        <Swatches colors={[...new Set([style.brandColor, ...COLORS])]} current={textStyle.color} label="文字颜色" reset="恢复默认颜色"
                  onPick={color => setTextStyle({ color: color || null })} />
      </details>
      <details className="ice-doc-pop">
        <summary className="ice-doc-tool" title="背景色（高亮）" aria-label="背景色"><span className="ice-doc-hl" style={{ background: textStyle.backgroundColor || "#fff3a3" }}>ab</span></summary>
        <Swatches colors={HIGHLIGHTS} current={textStyle.backgroundColor} label="背景色" reset="清除背景色"
                  onPick={color => setTextStyle({ backgroundColor: color || null })} />
      </details>
      <span className="ice-doc-tool-sep" />
      {(["left", "center", "right", "justify"] as const).map(value =>
        <T key={value} label={{ left: "左对齐", center: "居中", right: "右对齐", justify: "两端对齐" }[value]} active={align === value}
           onClick={() => setAlign(value)}>{{ left: "⇤", center: "≡", right: "⇥", justify: "☰" }[value]}</T>)}
      <T label="首行缩进两字" active={indent} onClick={() => chain().updateAttributes("paragraph", { indent: indent ? null : true }).run()}>⇥¶</T>
      <select aria-label="全文行距" title="全文行距" value={style.lineHeight} onChange={event => onStyle({ lineHeight: Number(event.target.value) })}>
        {LINE_HEIGHTS.map(value => <option key={value} value={value}>行距 {value}</option>)}
      </select>
      <select aria-label="全文段距" title="全文段落间距" value={style.paragraphSpacing} onChange={event => onStyle({ paragraphSpacing: Number(event.target.value) })}>
        {PARAGRAPH_SPACINGS.map(value => <option key={value} value={value}>段距 {value}</option>)}
      </select>
      <select aria-label="全文字间距" title="全文字间距" value={style.letterSpacing ?? 0.5} onChange={event => onStyle({ letterSpacing: Number(event.target.value) })}>
        {LETTER_SPACINGS.map(value => <option key={value} value={value}>字距 {value}</option>)}
      </select>
      <span className="ice-doc-tool-sep" />
      <T label="无序列表" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>•≡</T>
      <T label="有序列表" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>1.</T>
      <T label="行内代码" active={editor.isActive("code")} onClick={() => chain().toggleCode().run()}>{"<>"}</T>
      <T label="链接" active={editor.isActive("link")} onClick={() => { setHref(String(editor.getAttributes("link").href ?? "")); setLinkOpen(value => !value); }}>🔗</T>
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

/** 文章设置（对应公众号编辑页的“文章设置”）：封面、摘要、原文链接。作者在标题下方填写。 */
function ArticleSettings({ info, onChange, onClose, editor }: { info: DocInfo; onChange: (patch: Partial<DocInfo>) => void; onClose: () => void; editor: Editor | null }) {
  const firstImage = React.useMemo(() => {
    let id: string | null = null;
    editor?.state.doc.descendants(node => { if (!id && node.type.name === "articleImage" && node.attrs.resourceId) id = String(node.attrs.resourceId); return !id; });
    return id;
  }, [editor, info]);
  const coverId = info.coverResourceId || firstImage;
  const summary = info.summary ?? "";
  return (
    <div className="ice-doc-settings" role="dialog" aria-label="文章设置">
      <div className="ice-doc-row"><strong>文章设置</strong><span style={{ flex: 1 }} /><button type="button" className="ice-link-btn" onClick={onClose}>收起</button></div>
      <label>封面
        <div className="ice-doc-cover">
          {coverId ? <CoverThumb resourceId={coverId} /> : <div className="ice-doc-cover__empty">正文还没有图片</div>}
          <div className="ice-doc-cover__actions">
            <Button size="sm" onClick={async () => {
              const owner = accountStore.get(), target = editor;
              const image = await pickDocumentImage(owner);
              // 选择框打开期间离开文章或切号：不把封面写到别处。
              if (image && accountStore.get() === owner && target && !target.isDestroyed) onChange({ coverResourceId: image.resource_id });
            }}>另选封面</Button>
            {info.coverResourceId && <button type="button" className="ice-link-btn" onClick={() => onChange({ coverResourceId: "" })}>改回正文第一张图</button>}
          </div>
        </div>
        <span className="ice-doc-muted">{info.coverResourceId ? "已指定封面" : "默认取正文第一张图"}；导出图文包时另存为“封面”文件，便于在后台上传。</span>
      </label>
      <label>摘要
        <textarea aria-label="摘要" className="ice-doc-textarea" rows={3} maxLength={SUMMARY_LIMIT} value={summary} placeholder="选填，不填写则后台默认抓取正文前 54 字"
                  onChange={event => onChange({ summary: event.target.value })} />
        <span className="ice-doc-counter">{summary.length}/{SUMMARY_LIMIT}</span>
      </label>
      <label>原文链接（选填）
        <Input aria-label="原文链接（选填）" value={info.sourceUrl ?? ""} placeholder="https://" onChange={event => onChange({ sourceUrl: event.target.value })} />
      </label>
      <p className="ice-doc-muted">这些信息随版本保存，并写入导出包的 manifest；粘贴到公众号后，请在后台对应位置填写。</p>
    </div>
  );
}

function CoverThumb({ resourceId }: { resourceId: string }) {
  const [view, setView] = React.useState<ImageView | null>(null);
  React.useEffect(() => {
    let active = true;
    docRpc<ImageView>("documents.image_view", { resource_id: resourceId }).then(value => { if (active) setView(value); }).catch(() => { if (active) setView(null); });
    return () => { active = false; };
  }, [resourceId]);
  return view?.ok ? <img className="ice-doc-cover__img" src={view.preview} alt="封面" /> : <div className="ice-doc-cover__empty">封面图片缺失</div>;
}
