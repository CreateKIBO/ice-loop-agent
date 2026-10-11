// 统一文章编辑器（M3-02/03/04/09）：Tiptap 富文本 + 源模式 + 保存与恢复 +
// 审批过期提示。保存链：debounce → editor_draft（工作草稿）；显式“保存新版本”
// → articles.save（新 revision，hash 冲突即失败并保留本地内容）。
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, ErrorPanel, Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { dirtyStore, editorStore, flushAllDirty, registerDirtyFlush, rpc, useObjectDirty, type RpcError } from "../../data/client";
import "../../styles/editor.css";
import { docToMarkdown, markdownToDoc, type EditorBlockJSON } from "./markdownBridge";
import { ImageSlot, RawBlock, RunOutput } from "./nodes";
import { PatchReview } from "./PatchReview";
import { DeliveryReviewDialog, refreshDeliverySnapshot, reviewBadge, useDeliverySnapshot } from "./DeliveryReview";

// 流程图依赖 @xyflow/react（体积大）且默认折叠：展开时才下载、才发请求。
const WorkflowGraph = React.lazy(() =>
  import("../workflow/WorkflowGraph").then(module => ({ default: module.WorkflowGraph })));

type DocumentResult = {
  document: EditorBlockJSON;
  markdown: string;
  content_hash: string;
  revision_id: string | null;
  slots: Record<string, Array<Record<string, unknown>>>;
};

type ApprovalStatus = {
  current_hash: string; approved_hash: string | null; stale: boolean;
  approved_scope: string | null; workflow_gates: unknown[];
};

export function ArticleEditor({ jobId }: { jobId: string }) {
  const dirtyKey = "job:" + jobId + ":editor";
  const isDirty = useObjectDirty(dirtyKey);
  const [data, setData] = React.useState<DocumentResult | null>(null);
  const [approval, setApproval] = React.useState<ApprovalStatus | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loadTick, setLoadTick] = React.useState(0);
  const [saveState, setSaveState] = React.useState<"saved" | "saving" | "error" | "dirty">("saved");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [savedDraft, setSavedDraft] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"rich" | "source">("rich");
  const [sourceText, setSourceText] = React.useState("");
  const loadedHash = React.useRef<string>("");
  const debounceTimer = React.useRef<number | undefined>(undefined);
  const draftSequence = React.useRef(0);

  const scheduleDraft = (markdown: string) => {
    dirtyStore.markDirty(dirtyKey);
    setSaveState("dirty");
    setSaveError(null);
    window.clearTimeout(debounceTimer.current);
    const sequence = ++draftSequence.current;
    debounceTimer.current = window.setTimeout(async () => {
      try {
        await rpc("articles.editor_draft_save", {
          job_id: jobId, content: markdown, base_revision: loadedHash.current,
        });
        if (sequence === draftSequence.current) setSaveState("saved");
      } catch (error) {
        if (sequence === draftSequence.current) {
          setSaveState("error");
          setSaveError((error as Error).message);
        }
      }
    }, 800);
  };

  const load = React.useCallback(() => {
    setLoadError(null);
    Promise.all([
      rpc<DocumentResult>("articles.document", { job_id: jobId }),
      rpc<ApprovalStatus>("articles.approval_status", { job_id: jobId }).catch(() => null),
      rpc<{ draft: { content: string } | null }>("articles.editor_draft_get", { job_id: jobId }).catch(() => null),
    ]).then(([doc, approvalStatus, draft]) => {
      loadedHash.current = doc.content_hash;
      setData(doc);
      setApproval(approvalStatus);
      setSourceText(doc.markdown);
      setSavedDraft(draft?.draft && draft.draft.content !== doc.markdown ? draft.draft.content : null);
      setSaveState("saved");
      dirtyStore.markClean(dirtyKey);
    }).catch((error: Error) => setLoadError(error.message));
  }, [jobId, dirtyKey]);
  React.useEffect(() => { load(); }, [load, loadTick]);

  const editor = useEditor({
    extensions: [StarterKit, ImageSlot, RunOutput, RawBlock],
    content: { type: "doc", content: [] },
    onUpdate: ({ editor: current }) => {
      const markdown = docToMarkdown(current.getJSON() as EditorBlockJSON);
      setSourceText(markdown);
      scheduleDraft(markdown);
    },
    editorProps: { attributes: { class: "ice-editor", spellcheck: "false" } },
  });

  // 文档加载完成后填充编辑器（以 hash 为键，避免打字过程中被覆盖）。
  const loadedFor = React.useRef<string>("");
  React.useEffect(() => {
    if (data && editor && loadedFor.current !== data.content_hash) {
      loadedFor.current = data.content_hash;
      editor.commands.setContent(markdownToDoc(data.markdown) as never, { emitUpdate: false });
    }
  }, [data, editor]);
  React.useEffect(() => () => {
    window.clearTimeout(debounceTimer.current);
    draftSequence.current += 1;
  }, []);

  // R04 批次二：导航/切账号前把 debounce 窗口内未落盘的修改立即写入工作草稿。
  // sourceText 由 onUpdate/switchMode 持续同步，是两个模式的共同规范值。
  React.useEffect(() => {
    return registerDirtyFlush(dirtyKey, async () => {
      if (!sourceText) return;
      window.clearTimeout(debounceTimer.current);
      await rpc("articles.editor_draft_save", {
        job_id: jobId, content: sourceText, base_revision: loadedHash.current,
      });
    });
  }, [dirtyKey, jobId, sourceText]);

  const refresh = () => {
    setLoadTick(tick => tick + 1);
    void refreshDeliverySnapshot();
  };
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const delivery = useDeliverySnapshot(jobId);
  const deliveryBadge = reviewBadge(delivery.data);

  const currentMarkdown = () => (mode === "rich" && editor)
    ? docToMarkdown(editor.getJSON() as EditorBlockJSON)
    : sourceText;

  const saveVersion = async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      await rpc("articles.save", { job_id: jobId, body: currentMarkdown(),
                                   content_hash: loadedHash.current });
      dirtyStore.markClean(dirtyKey);
      setConflict(null);
      refresh();
      toast.success({ title: "已保存新版本", detail: "可在经典界面的版本历史中对比和回滚" });
    } catch (error) {
      const rpcError = error as RpcError;
      setSaveState("error");
      setSaveError(rpcError.message);
      if ((rpcError.message ?? "").includes("已变化")) {
        setConflict("正文在别处已被修改。你的内容仍在编辑器中，可先复制或另存工作草稿，再刷新合并。");
      }
    }
  };

  // Ctrl+S 保存新版本。经 ref 调用最新的 saveVersion，避免每次渲染重绑监听。
  const saveRef = React.useRef(saveVersion);
  saveRef.current = saveVersion;
  const savingRef = React.useRef(false);
  savingRef.current = saveState === "saving";
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!savingRef.current) void saveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const backToChat = async () => {
    try { await flushAllDirty(); editorStore.set(null); }
    catch (error) { setSaveError((error as Error).message); }
  };

  const adoptDraft = () => {
    if (!savedDraft) return;
    if (editor) editor.commands.setContent(markdownToDoc(savedDraft) as never, { emitUpdate: false });
    setSourceText(savedDraft);
    setSavedDraft(null);
    scheduleDraft(savedDraft);
  };

  const switchMode = () => {
    if (!editor) return;
    if (mode === "rich") {
      setSourceText(docToMarkdown(editor.getJSON() as EditorBlockJSON));
      setMode("source");
    } else {
      editor.commands.setContent(markdownToDoc(sourceText) as never, { emitUpdate: false });
      setMode("rich");
    }
  };

  // 可信导出（R05/R06/R13）：目录由系统对话框选择（短期批准引用），
  // 后端 articles.export_bundle 再做统一就绪校验与所有权保护。
  const [exporting, setExporting] = React.useState<"draft" | "ready" | null>(null);
  const [exportNote, setExportNote] = React.useState<string | null>(null);
  const exportBundle = async (mode: "draft" | "ready") => {
    if (exporting) return;
    if (isDirty) { setExportNote("当前编辑尚未保存为正文版本，请先点击「保存新版本」后导出。"); return; }
    const bridge = (window as unknown as { ice?: { chooseExportDir?: () => Promise<string | null> } }).ice;
    if (!bridge?.chooseExportDir) {
      setExportNote("此运行环境不支持目录选择（需桌面应用）。");
      return;
    }
    setExporting(mode);
    setExportNote(null);
    try {
      const dir = await bridge.chooseExportDir();
      if (!dir) return;
      const result = await rpc<{ destination: string; images: number; checks: { blocking: string[] } }>(
        "articles.export_bundle", { job_id: jobId, destination: dir, mode });
      const detail = `${result.images} 张图片 → ${result.destination}`;
      if (result.checks.blocking.length) {
        toast.warning({ title: "已导出，但有阻断项", detail: detail + "；" + result.checks.blocking.join("；") });
      } else {
        toast.success({ title: mode === "ready" ? "发布就绪包已导出" : "草稿包已导出", detail });
      }
    } catch (error) {
      const message = (error as RpcError).message ?? "";
      toast.error({ title: "导出未完成", detail: message,
                    action: mode === "ready" ? { label: "打开交付审阅", run: () => setReviewOpen(true) } : undefined });
    } finally {
      setExporting(null);
    }
  };

  if (loadError) {
    return <div style={{ padding: 16 }}><ErrorPanel title="文章加载失败"
      detail={loadError} onRetry={refresh} /></div>;
  }
  if (!data) {
    return <div style={{ display: "grid", placeItems: "center", flex: 1 }}><Spinner /></div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: "var(--ice-space-4)",
                  gap: "var(--ice-space-3)", overflowY: "auto" }}>
      <div className="ice-editor-bar">
        <Button variant="ghost" onClick={backToChat} title="未保存的修改会先存为工作草稿">← 返回对话</Button>
        <strong title={"内容 hash " + data.content_hash}>文章编辑</strong>
        <span className={"ice-badge" + (saveState === "error" ? " ice-badge--danger"
                                        : saveState === "dirty" ? " ice-badge--warning" : "")}
              role="status">
          {saveState === "saving" ? "正在保存…" : saveState === "saved" ? (isDirty ? "工作草稿已保存" : "正文已加载") :
            saveState === "error" ? "保存失败" : isDirty ? "编辑中" : "已保存"}
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={switchMode} title="在富文本和 Markdown 源码之间切换">
          {mode === "rich" ? "源模式" : "富文本"}
        </Button>
        <Button onClick={() => setReviewOpen(true)} title="核对标题、正文、配图与检查结果，确认后才能导出发布就绪包">
          交付审阅
          <span className={"ice-badge" + (deliveryBadge.tone ? " ice-badge--" + deliveryBadge.tone : "")}
                style={{ marginLeft: 2 }}>{deliveryBadge.label}</span>
        </Button>
        <Button loading={exporting === "draft"} disabled={exporting !== null && exporting !== "draft"}
                onClick={() => exportBundle("draft")}>导出草稿包</Button>
        <Button loading={exporting === "ready"} disabled={exporting !== null && exporting !== "ready"}
                onClick={() => exportBundle("ready")}>导出发布就绪包</Button>
        <Button variant="primary" loading={saveState === "saving"} onClick={saveVersion}
                disabled={saveState === "saving"} title="Ctrl+S">
          保存新版本
        </Button>
      </div>

      {exportNote && (
        <div role="status" style={{ fontSize: "var(--ice-font-size-sm)",
                                    color: exportNote.startsWith("已导出") ? "var(--ice-success)" : "var(--ice-warning)" }}>
          {exportNote}
        </div>
      )}

      <AnimatePresence>
        {approval?.stale && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }} transition={{ duration: 0.18 }} key="stale-banner">
            <Banner tone="warning" title="审批基线已过期">
              已批准的正文与此版本不一致，请重新同步审阅后再导出。
            </Banner>
          </motion.div>
        )}
        {conflict && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }} transition={{ duration: 0.18 }} key="conflict">
            <Banner tone="danger" title="保存冲突" actions={
              <Button onClick={refresh}>刷新最新版</Button>}>{conflict}</Banner>
          </motion.div>
        )}
        {savedDraft && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }} transition={{ duration: 0.18 }} key="draft-banner">
            <Banner tone="info" title="检测到未保存的工作草稿" actions={
              <><Button onClick={adoptDraft}>恢复草稿</Button>
                <Button variant="ghost" onClick={() => {
                  rpc("articles.editor_draft_clear", { job_id: jobId }).catch(() => null);
                  setSavedDraft(null);
                }}>丢弃草稿</Button></>}>
              草稿与当前正文不同；恢复不会影响已批准版本。
            </Banner>
          </motion.div>
        )}
      </AnimatePresence>

      {saveError && <div role="alert" style={{ color: "var(--ice-danger)", fontSize: "var(--ice-font-size-sm)" }}>{saveError}</div>}

      {mode === "rich" ? (
        <>
          <Toolbar editor={editor} />
          {/* 外层容器负责滚动；这里若允许收缩，正文会溢出并盖住下方的修改提案。 */}
          <EditorContent editor={editor} style={{ flexShrink: 0 }} />
        </>
      ) : (
        <SourceEditor value={sourceText} onChange={value => {
          setSourceText(value);
          scheduleDraft(value);
        }} />
      )}

      <PatchReview jobId={jobId} onApplied={refresh} />
      <WorkflowDisclosure jobId={jobId} />
      <DeliveryReviewDialog jobId={jobId} open={reviewOpen} onOpenChange={setReviewOpen} dirty={isDirty}
                            onExportReady={() => void exportBundle("ready")} />
    </div>
  );
}

function WorkflowDisclosure({ jobId }: { jobId: string }) {
  const [opened, setOpened] = React.useState(false);
  return (
    <details style={{ borderTop: "1px solid var(--ice-border)", paddingTop: "var(--ice-space-3)" }}
             onToggle={event => setOpened(event.currentTarget.open)}>
      <summary style={{ cursor: "pointer", fontSize: "var(--ice-font-size-md)", fontWeight: 600 }}>
        工作流状态图
      </summary>
      <div style={{ marginTop: "var(--ice-space-2)" }}>
        {opened && (
          <React.Suspense fallback={<Spinner size={16} />}>
            <WorkflowGraph jobId={jobId} />
          </React.Suspense>
        )}
      </div>
    </details>
  );
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null;
  const btn = (label: string, active: boolean, action: () => void) => (
    <button type="button" onClick={action} className="ice-tool-btn" aria-pressed={active}>{label}</button>
  );
  return (
    <div role="toolbar" aria-label="格式" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {btn("撤销", false, () => editor.chain().focus().undo().run())}
      {btn("重做", false, () => editor.chain().focus().redo().run())}
      {btn("标题2", editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
      {btn("标题3", editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
      {btn("粗体", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
      {btn("斜体", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
      {btn("行内代码", editor.isActive("code"), () => editor.chain().focus().toggleCode().run())}
      {btn("代码块", editor.isActive("codeBlock"), () => editor.chain().focus().toggleCodeBlock().run())}
      {btn("引用", editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run())}
      {btn("无序列表", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
      {btn("有序列表", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
      {btn("分隔线", false, () => editor.chain().focus().setHorizontalRule().run())}
    </div>
  );
}

// 源模式：CodeMirror 优先，运行时异常回退 textarea（保输入、可保存）。
function SourceEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) {
    return <textarea value={value} onChange={event => onChange(event.target.value)} rows={18}
                     aria-label="正文源码"
                     style={{ fontFamily: "var(--ice-font-mono)", padding: 12, borderRadius: 8,
                              border: "1px solid var(--ice-border)", resize: "vertical" }} />;
  }
  return <CodeMirrorSource value={value} onChange={onChange} onError={() => setFailed(true)} />;
}

function CodeMirrorSource({ value, onChange, onError }: {
  value: string; onChange: (v: string) => void; onError: () => void;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    let view: { destroy: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const [{ EditorView }, { basicSetup }, { markdown }] = await Promise.all([
          import("@codemirror/view"),
          import("codemirror"),
          import("@codemirror/lang-markdown"),
        ]);
        if (cancelled || !host.current) return;
        view = new EditorView({
          doc: value,
          extensions: [basicSetup, markdown(), EditorView.lineWrapping,
            EditorView.updateListener.of(update => {
              if (update.docChanged) onChange(update.state.doc.toString());
            })],
          parent: host.current,
        }) as unknown as { destroy: () => void };
      } catch {
        onError();
      }
    })();
    return () => { cancelled = true; view?.destroy(); };
    // 仅挂载时创建一次；内容经 updateListener 单向流出，避免光标跳动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} aria-label="正文源码" style={{
    border: "1px solid var(--ice-border)", borderRadius: "var(--ice-radius-md)",
    minHeight: 320, background: "var(--ice-surface)", overflow: "auto",
  }} />;
}
