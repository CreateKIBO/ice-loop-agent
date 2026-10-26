// 统一文章编辑器（M3-02/03/04/09）：Tiptap 富文本 + 源模式 + 保存与恢复 +
// 审批过期提示。保存链：debounce → editor_draft（工作草稿）；显式“保存新版本”
// → articles.save（新 revision，hash 冲突即失败并保留本地内容）。
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, ErrorPanel, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { accountStore, dirtyStore, editorStore, flushAllDirty, registerDirtyFlush, rpc, useObjectDirty, type RpcError } from "../../data/client";
import { CopyButton } from '../../components/CopyButton';
import { exportProblems } from './exportModel';
import type { ExportResult } from './exportModel';
import "../../styles/editor.css";
import { docToMarkdown, markdownToDoc, markdownHeadings, type MarkdownHeading, type EditorBlockJSON } from "./markdownBridge";
import { ImageSlot, RawBlock, RunOutput } from "./nodes";
import { PatchReview } from "./PatchReview";
import { DeliveryReviewDialog, refreshDeliverySnapshot, reviewBadge, useDeliverySnapshot } from "./DeliveryReview";
import { EditorPersistence } from "./editorPersistence";

// 流程图依赖 @xyflow/react（体积大）且默认折叠：展开时才下载、才发请求。
const WorkflowGraph = React.lazy(() =>
  import("../workflow/WorkflowGraph").then(module => ({ default: module.WorkflowGraph })));
const AssetWorkspace = React.lazy(() => import('../assets/AssetWorkspace').then(module => ({ default: module.AssetWorkspace })));

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
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [savedDraft, setSavedDraft] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"rich" | "source">("rich");
  const [sourceText, setSourceText] = React.useState("");
  const [sourceNavigation, setSourceNavigation] = React.useState<{ line: number; token: number } | null>(null);
  const deferredText = React.useDeferredValue(sourceText);
  const headings = React.useMemo(() => markdownHeadings(deferredText), [deferredText]);
  const persistence = React.useMemo(() => new EditorPersistence(rpc, jobId), [jobId]);
  const latestText = React.useRef("");
  const editSequence = React.useRef(0);
  const headingFocusTimer = React.useRef<number | undefined>(undefined);
  const mounted = React.useRef(true);
  const versionPending = React.useRef(false);
  const reviewApplyingRef = React.useRef(false);
  const [reviewApplying, setReviewApplying] = React.useState(false);
  const [editorBody, setEditorBody] = React.useState<{ text: string } | null>(null);
  const debounceTimer = React.useRef<number | undefined>(undefined);
  const draftSequence = React.useRef(0);

  const scheduleDraft = (markdown: string) => {
    latestText.current = markdown;
    editSequence.current += 1;
    dirtyStore.markDirty(dirtyKey);
    setSaveState("dirty");
    setSaveError(null);
    window.clearTimeout(debounceTimer.current);
    const sequence = ++draftSequence.current;
    debounceTimer.current = window.setTimeout(async () => {
      try {
        await persistence.saveDraft(markdown);
        if (mounted.current && sequence === draftSequence.current && !versionPending.current) setSaveState("saved");
      } catch (error) {
        if (mounted.current && sequence === draftSequence.current) {
          setSaveState("error");
          setSaveError(error);
        }
      }
    }, 800);
  };

  const load = React.useCallback(() => {
    let cancelled = false;
    const sequence = editSequence.current;
    setLoadError(null);
    Promise.all([
      rpc<DocumentResult>("articles.document", { job_id: jobId }),
      rpc<ApprovalStatus>("articles.approval_status", { job_id: jobId }).catch(() => null),
      rpc<{ draft: { content: string } | null }>("articles.editor_draft_get", { job_id: jobId }),
    ]).then(([doc, approvalStatus, draft]) => {
      if (cancelled || sequence !== editSequence.current) return;
      persistence.setBaseline(doc.content_hash);
      latestText.current = doc.markdown;
      setData(doc);
      setApproval(approvalStatus);
      setSourceText(doc.markdown);
      setEditorBody({ text: doc.markdown });
      setSavedDraft(draft?.draft && draft.draft.content !== doc.markdown ? draft.draft.content : null);
      setSaveState("saved");
      dirtyStore.markClean(dirtyKey);
    }).catch((error: Error) => { if (!cancelled) setLoadError(error.message); });
    return () => { cancelled = true; };
  }, [jobId, dirtyKey, persistence]);
  React.useEffect(() => load(), [load, loadTick]);

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

  const navigateHeading = (heading: MarkdownHeading) => {
    if (deferredText !== sourceText || reviewApplyingRef.current) return;
    window.clearTimeout(headingFocusTimer.current);
    if (mode === "source") {
      setSourceNavigation(previous => ({ line: heading.line, token: (previous?.token ?? 0) + 1 }));
    } else if (editor) {
      let index = 0;
      editor.state.doc.forEach((node, position) => {
        if (node.type.name === "heading" && index++ === heading.index) {
          const document = editor.state.doc, opener = window.document.activeElement;
          // Tiptap focus() waits for rAF. An occluded Windows view can throttle that indefinitely.
          // Defer beyond React's event commit, then focus the existing view without an animation frame.
          headingFocusTimer.current = window.setTimeout(() => {
            if (!mounted.current || reviewApplyingRef.current || editor.isDestroyed || !editor.view.dom.isConnected || editor.state.doc !== document) return;
            const active = window.document.activeElement;
            if (active !== opener && active !== window.document.body && !editor.view.dom.contains(active)) return;
            editor.commands.setTextSelection(position + 1);
            editor.view.focus();
            editor.commands.scrollIntoView();
          }, 0);
        }
      });
    }
  };

  // Only an explicit document load/recovery installs content. A late save acknowledgement
  // updates the baseline without replacing the text currently being edited.
  React.useEffect(() => {
    if (editorBody && editor) {
      editor.commands.setContent(markdownToDoc(editorBody.text) as never, { emitUpdate: false });
    }
  }, [editorBody, editor]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(debounceTimer.current);
      window.clearTimeout(headingFocusTimer.current);
      draftSequence.current += 1;
    };
  }, []);

  // R04 批次二：导航/切账号前把 debounce 窗口内未落盘的修改立即写入工作草稿。
  // sourceText 由 onUpdate/switchMode 持续同步，是两个模式的共同规范值。
  const flushDraft = React.useCallback(async () => {
    // If typing continues while a write is in flight, persist the newer content too.
    // Navigation is refused rather than losing input under a continuously changing editor.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      window.clearTimeout(debounceTimer.current);
      const sequence = editSequence.current;
      await persistence.saveDraft(latestText.current);
      if (sequence === editSequence.current) return;
    }
    throw new Error("内容仍在修改，请稍后重试切换，当前输入已保留。");
  }, [persistence]);
  React.useEffect(() => registerDirtyFlush(dirtyKey, flushDraft), [dirtyKey, flushDraft]);

  const refresh = () => {
    if (data && dirtyStore.isDirty(dirtyKey)) {
      setConflict("正文已有新版本，你的编辑仍保留在这里。点击「保留草稿并刷新」后可恢复并合并。");
      return;
    }
    setLoadTick(tick => tick + 1);
    void refreshDeliverySnapshot();
  };
  const beginProposalApply = () => {
    if (versionPending.current || reviewApplyingRef.current || dirtyStore.isDirty(dirtyKey) || savedDraft !== null) {
      throw Error("正文还有未保存为版本的修改或恢复草稿，请先保存新版本或处理恢复草稿；审阅决定继续保留。");
    }
    reviewApplyingRef.current = true; setReviewApplying(true);
    editor?.setEditable(false, false);
    return () => {
      reviewApplyingRef.current = false;
      if (mounted.current) setReviewApplying(false);
      if (editor && !editor.isDestroyed) editor.setEditable(true, false);
    };
  };
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [assetFigure, setAssetFigure] = React.useState<number | null>(null);
  const showAssets = (figure = 0) => {
    if (isDirty) { setSaveError('配图操作基于已保存正文，请先保存新版本；当前编辑保留。'); return; }
    setReviewOpen(false); setAssetFigure(figure);
  };
  const delivery = useDeliverySnapshot(jobId);
  const deliveryBadge = reviewBadge(delivery.data);

  const currentMarkdown = () => (mode === "rich" && editor)
    ? docToMarkdown(editor.getJSON() as EditorBlockJSON)
    : sourceText;

  const saveVersion = async () => {
    if (!data || versionPending.current || reviewApplyingRef.current) return;
    versionPending.current = true;
    window.clearTimeout(debounceTimer.current);
    draftSequence.current += 1;
    const submitted = currentMarkdown();
    const sequence = editSequence.current;
    setSaveState("saving");
    setSaveError(null);
    try {
      const result = await persistence.saveVersion(submitted);
      if (!mounted.current) return;
      setData(previous => previous && ({ ...previous, markdown: submitted,
        content_hash: result.content_hash, revision_id: result.revision_id }));
      const unchanged = sequence === editSequence.current;
      if (unchanged) dirtyStore.markClean(dirtyKey);
      setSaveState(unchanged ? "saved" : "dirty");
      setConflict(null);
      setSavedDraft(null);
      if (result.draftError) setSaveError("正文版本已保存，但恢复草稿同步失败：" + result.draftError);
      void refreshDeliverySnapshot();
      void rpc<ApprovalStatus>("articles.approval_status", { job_id: jobId })
        .then(value => { if (mounted.current) setApproval(value); }).catch(() => undefined);
      toast.success({ title: "已保存新版本", detail: unchanged
        ? "可在版本历史中对比和回滚" : "保存期间的新修改已保留，请继续编辑或再次保存。" });
    } catch (error) {
      if (!mounted.current) return;
      const rpcError = error as RpcError;
      setSaveState("error");
      setSaveError(error);
      if ((rpcError.message ?? "").includes("已变化")) {
        setConflict("正文在别处已被修改。你的内容仍在编辑器中，可先复制或另存工作草稿，再刷新合并。");
      }
    } finally {
      versionPending.current = false;
    }
  };

  // Ctrl+S 保存新版本。经 ref 调用最新的 saveVersion，避免每次渲染重绑监听。
  const saveRef = React.useRef(saveVersion);
  saveRef.current = saveVersion;
  const savingRef = React.useRef(false);
  savingRef.current = versionPending.current;
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return; // IME 组词期间的组合键不触发保存
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
    catch (error) { setSaveError(error); }
  };

  const adoptDraft = () => {
    if (savedDraft === null || reviewApplyingRef.current) return;
    if (editor) editor.commands.setContent(markdownToDoc(savedDraft) as never, { emitUpdate: false });
    setSourceText(savedDraft);
    setSavedDraft(null);
    scheduleDraft(savedDraft);
  };

  const preserveAndRefresh = async () => {
    try {
      await flushDraft();
      setConflict(null);
      setLoadTick(tick => tick + 1);
    } catch (error) { setSaveError(error); }
  };

  const switchMode = () => {
    if (!editor || reviewApplyingRef.current) return;
    window.clearTimeout(headingFocusTimer.current);
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
  const [exportResult,setExportResult]=React.useState<ExportResult|null>(null);
  const [exportStage,setExportStage]=React.useState('');
  const exportingRef=React.useRef(false),exportDirtyKey=dirtyKey+':export';
  React.useEffect(()=>{
    const off=registerDirtyFlush(exportDirtyKey,()=>{if(exportingRef.current)throw Error('导出正在进行，请等待完成或取消目录选择');});
    return()=>{off();dirtyStore.markClean(exportDirtyKey);};
  },[exportDirtyKey]);
  const exportBundle = async (mode: "draft" | "ready") => {
    if (exportingRef.current) return;
    if (!data||dirtyStore.isDirty(dirtyKey)||versionPending.current) { setExportNote("当前编辑尚未保存为正文版本，请先点击「保存新版本」后导出。"); return; }
    const bridge = window.ice;
    if (!bridge?.chooseExportDir) {
      setExportNote("此运行环境不支持目录选择（需桌面应用）。");
      return;
    }
    const account=accountStore.get(),sequence=editSequence.current,bodyHash=data.content_hash;
    let selected:string|null=null,completed=false;
    const current=()=>mounted.current&&accountStore.get()===account;
    exportingRef.current=true;dirtyStore.markDirty(exportDirtyKey);setExporting(mode);
    setExportNote(null);
    setExportResult(null);
    setExportStage('正在检查当前导出版本…');
    try {
      let deliveryHash:string|undefined;
      if(mode==='ready'){
        const snapshot=await rpc<import('./DeliveryReview').DeliverySnapshot>('articles.delivery_snapshot',{job_id:jobId,account_id:account});
        if(!current())return;
        if(!snapshot.review.reviewed||snapshot.blocking.length||snapshot.running||snapshot.body_hash!==bodyHash){
          setReviewOpen(true);setExportNote('发布就绪包尚未完成当前版本的交付审阅，请先处理审阅页中的项目。');return;
        }
        deliveryHash=snapshot.delivery_hash;
      }
      setExportStage('请在系统窗口选择导出位置…');
      selected=await bridge.chooseExportDir();
      if(!current())return;
      if(!selected){setExportNote('已取消导出，正文保持不变。');return;}
      if(sequence!==editSequence.current||dirtyStore.isDirty(dirtyKey)||versionPending.current)throw Error('选择目录期间正文发生了变化，请先保存后重新导出');
      setExportStage('正在核对并写入文本与图片…');
      const result=await rpc<ExportResult>('articles.export_bundle',{
        job_id:jobId,account_id:account,destination:selected,mode,body_hash:bodyHash,...(deliveryHash?{delivery_hash:deliveryHash}:{}),
      });
      completed=true;
      if(!current())return;
      setExportResult(result);
      const problems=exportProblems(result.checks);
      if (problems.length) {
        toast.warning({ title: "草稿包已导出，仍有待处理项", detail:`${result.images}张图片已归档，仍有${problems.length}项待处理，详见正文上方的导出结果。` });
      } else {
        toast.success({ title: mode === "ready" ? "发布就绪包已导出" : "草稿包已导出", detail:`${result.images}张图片已归档，位置和校验结果见正文上方。` });
      }
    } catch (error) {
      if(!current())return;
      const message = (error as RpcError).message ?? "";
      toast.error({ title: "导出未完成", detail: message,
                    action: mode === "ready" ? { label: "打开交付审阅", run: () => setReviewOpen(true) } : undefined });
    } finally {
      if(selected&&!completed)try{await bridge.cancelExportDir?.(selected);}catch{/* Expired/cleared grants are already unusable. */}
      exportingRef.current=false;dirtyStore.markClean(exportDirtyKey);
      if(current())setExporting(null);
    }
  };

  if (loadError && !data) {
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
        <div className="ice-editor-bar__primary">
          <Button variant="ghost" onClick={backToChat} title="未保存的修改会先存为工作草稿">← 返回对话</Button>
          <div className="ice-editor-bar__identity">
            <strong title={"内容 hash " + data.content_hash}>文章编辑</strong>
            <span className={"ice-badge" + (saveState === "error" ? " ice-badge--danger"
                                        : saveState === "dirty" ? " ice-badge--warning" : "")}
              role="status">
              {versionPending.current ? "正在保存版本…" : saveState === "saved" ? (isDirty ? "工作草稿已保存" : "正文已加载") :
                saveState === "error" ? "保存失败" : isDirty ? "编辑中" : "已保存"}
            </span>
          </div>
          <Button variant="primary" loading={versionPending.current} onClick={saveVersion}
                disabled={versionPending.current || reviewApplying} title="Ctrl+S">
            保存新版本
          </Button>
        </div>
        <div className="ice-editor-bar__secondary">
          <span className="ice-editor-bar__count" title="包括 Markdown 标记在内的字符数">{sourceText.length.toLocaleString()} 字符</span>
          <div className="ice-editor-bar__actions" role="group" aria-label="文章操作">
            <Button disabled={reviewApplying} onClick={switchMode} title="在富文本和 Markdown 源码之间切换">
              {mode === "rich" ? "源模式" : "富文本"}
            </Button>
            <Button disabled={reviewApplying} onClick={() => showAssets()}>准备配图</Button>
            <Button disabled={reviewApplying} onClick={() => setReviewOpen(true)} title="核对标题、正文、配图与检查结果，确认后才能导出发布就绪包">
              交付审阅
              {delivery.data && <span className={"ice-badge" + (deliveryBadge.tone ? " ice-badge--" + deliveryBadge.tone : "")}
                style={{ marginLeft: 2 }}>{deliveryBadge.label}</span>}
            </Button>
            <Button loading={exporting === "draft"} disabled={reviewApplying || exporting !== null && exporting !== "draft"}
                    onClick={() => exportBundle("draft")}>导出草稿包</Button>
            <Button loading={exporting === "ready"} disabled={reviewApplying || exporting !== null && exporting !== "ready"}
                    onClick={() => exportBundle("ready")}>导出发布就绪包</Button>
          </div>
        </div>
      </div>

      {loadError && <ErrorPanel title="刷新未完成，当前编辑内容已保留" detail={loadError} onRetry={preserveAndRefresh} />}

      {exportNote && (
        <div role="status" style={{ fontSize: "var(--ice-font-size-sm)",
                                    color: exportNote.startsWith("已导出") ? "var(--ice-success)" : "var(--ice-warning)" }}>
          {exportNote}
        </div>
      )}
      {exporting&&<div role="status" style={{display:'flex',gap:8,alignItems:'center'}}><Spinner />{exportStage}</div>}
      {exportResult&&<Banner tone={exportProblems(exportResult.checks).length?'warning':'success'} title={exportResult.mode==='ready'?'发布就绪包已导出':'草稿包已导出'}>
        <div style={{display:'grid',gap:8}}>
          <span>文本文件夹包含Markdown与纯文本，图片文件夹包含{exportResult.images}张原图；另附校验清单。导出版本 {exportResult.source_body_sha256.slice(0,10)}。</span>
          <code style={{overflowWrap:'anywhere'}}>{exportResult.destination}</code>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <CopyButton text={exportResult.destination} label="复制导出路径" />
            {window.ice?.openExportFolder&&exportResult.can_open!==false&&<Button size="sm" onClick={()=>void window.ice?.openExportFolder?.(exportResult.destination).catch(problem=>toast.error({title:'打开目录失败',detail:(problem as Error).message}))}>打开导出文件夹</Button>}
          </div>
          {exportProblems(exportResult.checks).length>0&&<><strong>此包仍是草稿，请处理以下项目后重新审阅：</strong><ul style={{margin:0,paddingLeft:20}}>{exportProblems(exportResult.checks).map(problem=><li key={problem}>{problem}</li>)}</ul></>}
        </div>
      </Banner>}

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
              <Button onClick={preserveAndRefresh}>保留草稿并刷新</Button>}>{conflict}</Banner>
          </motion.div>
        )}
        {savedDraft !== null && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }} transition={{ duration: 0.18 }} key="draft-banner">
            <Banner tone="info" title="检测到未保存的工作草稿" actions={
              <><Button disabled={reviewApplying} onClick={adoptDraft}>恢复草稿</Button>
                <Button variant="ghost" disabled={reviewApplying} onClick={async () => {
                  if (reviewApplyingRef.current) return;
                  try {
                    await rpc("articles.editor_draft_clear", { job_id: jobId });
                    setSavedDraft(null);
                  } catch (error) { setSaveError(error); }
                }}>丢弃草稿</Button></>}>
              草稿与当前正文不同；恢复不会影响已批准版本。
            </Banner>
          </motion.div>
        )}
      </AnimatePresence>

      {saveError != null && <ErrorNote error={saveError} note="编辑器中的内容保留，可按提示处理后重试。" />}

      <details className="ice-article-outline">
        <summary>文章目录 · {headings.length} 个章节</summary>
        <nav aria-label="文章目录">
          {headings.length ? headings.map(heading => <button type="button" key={heading.index}
            disabled={deferredText !== sourceText} style={{ paddingInlineStart: 12 + (heading.level - 1) * 12 }}
            onClick={() => navigateHeading(heading)} title={heading.text}>
            <span aria-hidden="true">H{heading.level}</span> {heading.text}
          </button>) : <p>正文尚无章节标题，添加标题后可在这里定位。</p>}
        </nav>
      </details>

      <div inert={reviewApplying} aria-label="正文编辑区域" aria-busy={reviewApplying} style={{ display: "grid", gap: 8, flexShrink: 0 }}>
      {mode === "rich" ? (
        <>
          <Toolbar editor={editor} />
          {/* 外层容器负责滚动；这里若允许收缩，正文会溢出并盖住下方的修改提案。 */}
          <EditorContent editor={editor} style={{ flexShrink: 0 }} />
        </>
      ) : (
        <SourceEditor navigation={sourceNavigation} value={sourceText} onChange={value => {
          setSourceText(value);
          scheduleDraft(value);
        }} />
      )}

      </div>
      {reviewApplying && <div role="status">正在应用提案，正文编辑暂时锁定…</div>}
      <PatchReview jobId={jobId} onApplied={refresh} bodyBlocked={isDirty || savedDraft !== null || versionPending.current} beginApply={beginProposalApply} />
      <WorkflowDisclosure jobId={jobId} />
      <DeliveryReviewDialog jobId={jobId} open={reviewOpen} onOpenChange={setReviewOpen} dirty={isDirty}
                            onFixImages={showAssets}
                            onFixBody={() => { setReviewOpen(false); editor?.commands.focus(); }}
                            onExportReady={() => void exportBundle("ready")} />
      {assetFigure !== null && <React.Suspense fallback={<div role="status"><Spinner />正在打开配图工作台…</div>}>
        <AssetWorkspace jobId={jobId} figureNo={assetFigure || undefined} onClose={() => { setAssetFigure(null); void refreshDeliverySnapshot(); }} />
      </React.Suspense>}
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
type SourceNavigation = { line: number; token: number } | null;
function SourceEditor({ value, onChange, navigation }: { value: string; onChange: (v: string) => void; navigation: SourceNavigation }) {
  const [failed, setFailed] = React.useState(false);
  const fallback = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (!failed || !navigation || !fallback.current) return;
    const area = fallback.current, lines = value.split("\n");
    const start = lines.slice(0, Math.min(navigation.line - 1, lines.length - 1)).reduce((sum, line) => sum + line.length + 1, 0);
    area.focus(); area.setSelectionRange(start, start);
    area.scrollTop = (navigation.line - 1) * (Number.parseFloat(getComputedStyle(area).lineHeight) || 22);
  }, [failed, navigation]);
  if (failed) {
    return <textarea ref={fallback} value={value} onChange={event => onChange(event.target.value)} rows={18}
                     aria-label="正文源码"
                     style={{ fontFamily: "var(--ice-font-mono)", padding: 12, borderRadius: 8,
                              border: "1px solid var(--ice-border)", resize: "vertical" }} />;
  }
  return <CodeMirrorSource navigation={navigation} value={value} onChange={onChange} onError={() => setFailed(true)} />;
}

function CodeMirrorSource({ value, onChange, onError, navigation }: {
  value: string; onChange: (v: string) => void; onError: () => void; navigation: SourceNavigation;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const latest = React.useRef({ value, onChange, onError });
  latest.current = { value, onChange, onError };
  const viewRef = React.useRef<import("@codemirror/view").EditorView | null>(null);
  const [ready, setReady] = React.useState(false);
  const syncing = React.useRef(false);
  React.useEffect(() => {
    let view: import("@codemirror/view").EditorView | null = null;
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
          doc: latest.current.value,
          extensions: [basicSetup, markdown(), EditorView.lineWrapping,
            EditorView.updateListener.of(update => {
              if (update.docChanged && !syncing.current) latest.current.onChange(update.state.doc.toString());
            })],
          parent: host.current,
        });
        viewRef.current = view;
        setReady(true);
      } catch {
        if (!cancelled) latest.current.onError();
      }
    })();
    return () => { cancelled = true; view?.destroy(); viewRef.current = null; };
    // 仅挂载时创建一次；恢复/刷新经下一 effect 同步，不因每次输入重建视图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncing.current = true;
    try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }
    finally { syncing.current = false; }
  }, [value]);
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !navigation) return;
    const line = view.state.doc.line(Math.max(1, Math.min(navigation.line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  }, [navigation, ready]);
  return <div ref={host} aria-label="正文源码" style={{
    border: "1px solid var(--ice-border)", borderRadius: "var(--ice-radius-md)",
    minHeight: 320, background: "var(--ice-surface)", overflow: "auto",
  }} />;
}
