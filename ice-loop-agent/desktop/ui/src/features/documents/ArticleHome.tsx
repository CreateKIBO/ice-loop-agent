// 文章首页（C-01）：默认入口。空白 / 粘贴 / AI 起草三种开始方式；无模型、无栏目也能完成手动流程。
// 统一索引：v3 文章 + 尚未接入的旧草稿/旧任务（打开时按映射接入，不改写原文）。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, Dialog, EmptyState, Input, SkeletonRows, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { accountStore, conversationStore, editorStore, flushAllDirty, queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { articleCreateStore, documentStore, setWorkspace, settingsStore, trialDialogStore } from "../../app/uiState";
import { useModelReadiness } from "../../app/modelBootstrap";
import {
  ORIGIN_LABEL, THEMES, docRpc, formatTime, invalidateDocuments,
  type DocumentDetail, type DocumentList, type DocumentSummary, type LegacyItem,
} from "./documentsApi";
import { ArticleCalendar } from "./ArticleCalendar";
import { SuggestionsView } from "./SuggestionsView";
import { createBlankDocument, openDocument } from "./documentNav";
import { DeleteForeverDialog, trashDocument } from "./documentDelete";
import { SkillPicker, type SkillBinding } from "./DocumentSkills";
import "../../styles/documents.css";

// v3.24 多图文：对话框按需加载，不进首页主包
const WeChatGroupDialog = React.lazy(() => import("./WeChatGroupDialog").then(module => ({ default: module.WeChatGroupDialog })));

// 兼容旧引用：导航辅助函数已移到 documentNav.ts（避免左栏静态引用整个首页模块，破坏按需加载）。
export { createBlankDocument, openDocument };


/** P1：Word（.docx）文件导入。文件在本机读取后交给引擎本地转换，不上传任何服务。 */
async function readBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  return btoa(binary);
}


const PAGE = 60;

export function ArticleHome() {
  const account = useCurrentAccount();
  const [lifecycle, setLifecycle] = React.useState<"active" | "trashed">("active");
  // P2：文章 / 日历 / 待处理建议 / 回收站 四个视图；文章与回收站支持多选批量整理。
  const [view, setView] = React.useState<"list" | "calendar" | "suggestions" | "trash">("list");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const choose = (next: typeof view) => { setView(next); setSelected(new Set()); setLifecycle(next === "trash" ? "trashed" : "active"); };
  const [query, setQuery] = React.useState("");
  const deferred = React.useDeferredValue(query.trim());
  const list = useAccountQuery<DocumentList>("documents.list", { lifecycle, query: deferred },
    { staleTime: 2_000, refetchInterval: data => (data.state.data?.documents.some(d => d.generation_state === "running") ? 4_000 : 30_000) });
  const dialog = articleCreateStore.use();
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { setLifecycle("active"); setView("list"); setSelected(new Set()); setQuery(""); }, [account]);
  // v3.18：文章多时分批渲染（每行带布局动画，几百行一次挂载会明显卡顿）；换视图/搜索/公众号时回到第一批。
  const [limit, setLimit] = React.useState(PAGE);
  React.useEffect(() => { setLimit(PAGE); }, [account, lifecycle, deferred]);

  const blank = async () => {
    if (creating) return;
    setCreating(true);
    try { await createBlankDocument(); }
    catch (error) { toast.error({ title: "没有新建文章", detail: (error as Error).message }); }
    finally { setCreating(false); }
  };
  const [importing, setImporting] = React.useState(false);
  const wordInput = React.useRef<HTMLInputElement | null>(null);
  const importWord = async (file: File) => {
    if (!/\.docx$/i.test(file.name)) { toast.warning({ title: "只支持 .docx 文件", detail: "旧版 .doc 请先在 Word 里“另存为” .docx。" }); return; }
    if (file.size > 20 * 1024 * 1024) { toast.warning({ title: "Word 文件需小于 20MB", detail: "可以先在 Word 里压缩图片后再导入。" }); return; }
    setImporting(true);
    // v3.11 异步边界：导入归属发起时的公众号；读文件/转换期间切号或打开了别的文章，完成后不抢走当前页面。
    const owner = accountStore.get(), openedBefore = documentStore.get();
    try {
      await flushAllDirty();
      const data = await readBase64(file);
      const result = await docRpc<DocumentDetail & { report: { images: { total: number; imported: number; missing: unknown[] };
        islands: unknown[]; docx?: { unsupported: Record<string, number> } } }>("documents.import_docx",
        { account_id: owner, file_name: file.name, data_base64: data });
      void invalidateDocuments(owner);
      if (accountStore.get() !== owner) {
        toast.info({ title: `「${file.name}」已导入到原公众号`, detail: "导入期间切换了公众号；切回原公众号后可在文章列表中打开。" });
        return;
      }
      const skipped = Object.entries(result.report.docx?.unsupported ?? {});
      const notes = [`图片 ${result.report.images.imported}/${result.report.images.total}`,
        result.report.islands.length ? `${result.report.islands.length} 个表格/复杂模块保留为只读原件` : "",
        skipped.length ? "未导入：" + skipped.map(([label, count]) => `${label}×${count}`).join("、") : ""].filter(Boolean);
      toast.success({ title: `已导入「${file.name}」`, detail: notes.join("；") + "。导入报告与原件可在“版本”中查看。",
        action: documentStore.get() === openedBefore ? undefined : { label: "打开", run: () => void openDocument(result.document_id) } });
      if (documentStore.get() === openedBefore) { editorStore.set(null); documentStore.set(result.document_id); }
    } catch (error) { if (accountStore.get() === owner) toast.error({ title: "Word 文件没有导入", detail: (error as Error).message }); }
    finally { setImporting(false); }
  };
  // v3.12 长文多图性能固定样本（约 1 万字 / 30 图）。
  const [perfBusy, setPerfBusy] = React.useState(false);
  const createPerf = async () => {
    const owner = accountStore.get();
    setPerfBusy(true);
    try {
      const result = await docRpc<{ document_id: string; chars: number; images: number; image_bytes: number }>("documents.perf_sample", { account_id: owner });
      void invalidateDocuments(owner);
      toast.success({ title: "性能样本已生成", detail: `${result.chars} 字 / ${result.images} 张图（${(result.image_bytes / 1024 / 1024).toFixed(1)} MB）。打开后在侧栏“性能读数”查看。` });
      if (accountStore.get() === owner) void openDocument(result.document_id);
    } catch (error) { toast.error({ title: "性能样本没有生成", detail: (error as Error).message }); }
    finally { setPerfBusy(false); }
  };
  // v3.12 微信兼容测试稿：可一次生成多个主题，各成一篇（系列“兼容测试”）。
  const [compatOpen, setCompatOpen] = React.useState(false);
  const [compatBusy, setCompatBusy] = React.useState(false);
  const [compatThemes, setCompatThemes] = React.useState<string[]>(["clean"]);
  const createCompat = async () => {
    const owner = accountStore.get();
    setCompatBusy(true);
    try {
      const result = await docRpc<{ document_ids: string[] }>("documents.compat_create", { account_id: owner, themes: compatThemes });
      void invalidateDocuments(owner);
      setCompatOpen(false);
      toast.success({ title: `已生成 ${result.document_ids.length} 篇兼容测试稿`, detail: "打开后复制到公众号后台，在“兼容记录”里逐项填写。" });
      if (accountStore.get() === owner && result.document_ids[0]) void openDocument(result.document_ids[0]);
    } catch (error) { toast.error({ title: "测试稿没有生成", detail: (error as Error).message }); }
    finally { setCompatBusy(false); }
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
        <button type="button" className="ice-doc-start" disabled={importing} onClick={() => wordInput.current?.click()}>
          <strong>{importing ? "正在导入…" : "Word 导入"}</strong><span>选择 .docx 文件，本地转换，附导入报告</span></button>
        <button type="button" className="ice-doc-start" onClick={() => articleCreateStore.set("ai")}>
          <strong>AI 起草</strong><span>描述需求，后台生成独立初稿</span></button>
        <button type="button" className="ice-doc-start ice-doc-start--tool" disabled={compatBusy} onClick={() => setCompatOpen(true)}>
          <strong>{compatBusy ? "正在生成…" : "微信兼容测试稿"}</strong><span>覆盖全部元素的测试稿，逐项记录真实微信结果</span></button>
        <button type="button" className="ice-doc-start ice-doc-start--tool" disabled={perfBusy} onClick={() => void createPerf()}>
          <strong>{perfBusy ? "正在生成…" : "性能样本"}</strong><span>约 1 万字 / 30 张测试图的固定样本，侧栏看性能读数</span></button>
        <button type="button" className="ice-doc-start ice-doc-start--tool" onClick={() => trialDialogStore.set("open")}>
          <strong>作者试用记录</strong><span>邀请作者试用时记录用时、卡点与 AI 改稿量（本机、不含正文）</span></button>
        <input ref={wordInput} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
               hidden aria-label="选择 Word 文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importWord(file); }} />
      </div>
      <div className="ice-doc-home__filters">
        <Input type="search" value={query} placeholder="搜索标题或开头" aria-label="搜索文章" onChange={event => setQuery(event.target.value)}
               style={{ flex: 1 }} />
        <div className="ice-segmented" role="group" aria-label="文章视图">
          <button type="button" aria-pressed={view === "list"} onClick={() => choose("list")}>全部文章</button>
          <button type="button" aria-pressed={view === "calendar"} onClick={() => choose("calendar")}>发布日历</button>
          <button type="button" aria-pressed={view === "suggestions"} onClick={() => choose("suggestions")}>待处理建议</button>
          <button type="button" aria-pressed={view === "trash"} onClick={() => choose("trash")}>回收站</button>
        </div>
      </div>
      {view === "calendar" && <ArticleCalendar documents={list.data?.documents ?? []} />}
      {view === "suggestions" && <SuggestionsView />}
      {(view === "list" || view === "trash") && <>
      <BatchBar view={view} selected={selected} all={(list.data?.documents ?? []).map(d => d.document_id)}
                onSelect={setSelected} />
      {list.isLoading && <SkeletonRows rows={6} height={18} />}
      {list.error && <ErrorNote error={list.error} onRetry={() => list.refetch()} retryLabel="重新读取文章" />}
      {!list.isLoading && !list.error && documents.length === 0 && legacy.length === 0 && (
        <EmptyState title={lifecycle === "trashed" ? "回收站是空的" : query ? "没有匹配的文章" : "还没有文章"}
                    hint={lifecycle === "trashed" || query ? undefined : "选择上方任一种方式开始第一篇。"} />
      )}
      <ul className="ice-doc-list" aria-label="文章列表">
        <AnimatePresence initial={false}>
          {documents.slice(0, limit).map(item => <motion.li key={item.document_id} layout="position" initial={{ opacity: 0, y: 4 }}
                                            animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }}>
            <DocumentRow item={item} trashed={lifecycle === "trashed"} selected={selected.has(item.document_id)}
              onSelect={() => setSelected(previous => { const next = new Set(previous); if (next.has(item.document_id)) next.delete(item.document_id); else next.add(item.document_id); return next; })} />
          </motion.li>)}
        </AnimatePresence>
      </ul>
      {documents.length > limit && <div className="ice-doc-row ice-doc-more">
        <span className="ice-doc-muted">已显示 {limit} / {documents.length} 篇</span>
        <Button size="sm" variant="ghost" onClick={() => setLimit(value => value + PAGE)}>再显示 {Math.min(PAGE, documents.length - limit)} 篇</Button>
        <Button size="sm" variant="ghost" onClick={() => setLimit(documents.length)}>全部显示</Button>
      </div>}
      {lifecycle === "active" && legacy.length > 0 && <section className="ice-doc-legacy-list">
        <h2>旧稿件 <span className="ice-doc-muted">· {legacy.length}</span></h2>
        <p className="ice-doc-muted">旧草稿和旧制作任务在打开时接入为独立文章，原数据保持不变；旧任务的审批和运行记录只读保留。</p>
        <ul className="ice-doc-list">{legacy.map(item => <li key={item.id}><LegacyRow item={item} /></li>)}</ul>
      </section>}
      </>}
      <PasteDialog open={dialog === "paste"} onClose={() => articleCreateStore.set(null)} />
      <Dialog open={compatOpen} onOpenChange={setCompatOpen} title="生成微信兼容测试稿" width={480}
              description="测试稿包含段落、标题、文字样式、颜色/字号/高亮、链接、列表、引用、代码、分隔线、图片与图注、多图、提示卡片和间距，共 18 组，每组带编号。图片是程序生成的测试图。"
              footer={<><Button onClick={() => setCompatOpen(false)}>取消</Button>
                <Button variant="primary" loading={compatBusy} disabled={!compatThemes.length} onClick={() => void createCompat()}>生成 {compatThemes.length} 篇</Button></>}>
        <fieldset className="ice-doc-form" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="ice-doc-muted">要测试的主题（每个主题一篇）</legend>
          {THEMES.map(theme => <label key={theme.value} className="ice-doc-check">
            <input type="checkbox" checked={compatThemes.includes(theme.value)}
                   onChange={event => setCompatThemes(previous => event.target.checked ? [...previous, theme.value] : previous.filter(value => value !== theme.value))} />
            {theme.label} <span className="ice-doc-muted">· {theme.hint}</span></label>)}
        </fieldset>
      </Dialog>
      <AiDraftDialog open={dialog === "ai"} onClose={() => articleCreateStore.set(null)} />
    </div>
  );
}

/** P2 批量整理：移入回收站/恢复、设系列/清除系列、设计划日期/清除；一次最多 200 篇，整批成功或整批不改。 */
function BatchBar({ view, selected, all, onSelect }: { view: "list" | "trash"; selected: Set<string>; all: string[]; onSelect: (next: Set<string>) => void }) {
  const account = useCurrentAccount();
  const [busy, setBusy] = React.useState(false);
  const [series, setSeries] = React.useState("");
  const [date, setDate] = React.useState("");
  const [forever, setForever] = React.useState<string[] | "all" | null>(null);
  const [group, setGroup] = React.useState<string[] | null>(null);
  const run = async (action: string, extra: Record<string, unknown> = {}, label = "已完成") => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const result = await docRpc<{ changed: string[]; skipped: string[] }>("documents.batch", { action, document_ids: [...selected], ...extra });
      void invalidateDocuments(account);
      void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.calendar"] });
      toast.success({ title: `${label}：${result.changed.length} 篇`, detail: result.skipped.length ? `${result.skipped.length} 篇本来就是这个状态，已跳过。` : undefined });
      onSelect(new Set());
    } catch (error) { toast.error({ title: "批量操作没有执行", detail: (error as Error).message + "（整批未改动）" }); }
    finally { setBusy(false); }
  };
  if (!all.length) return null;
  const allOn = selected.size > 0 && selected.size === all.length;
  return (
    <div className={"ice-doc-batch" + (selected.size ? " is-active" : "")} role="toolbar" aria-label="批量整理">
      <label className="ice-doc-check"><input type="checkbox" checked={allOn} onChange={() => onSelect(allOn ? new Set() : new Set(all.slice(0, 200)))} />
        {selected.size ? `已选 ${selected.size} 篇` : "全选"}</label>
      {view === "trash" && <>
        {selected.size > 0 && <>
          <Button size="sm" loading={busy} onClick={() => void run("untrash", {}, "已恢复")}>恢复</Button>
          <Button size="sm" variant="ghost" className="ice-doc-danger-text" disabled={busy} onClick={() => setForever([...selected])}>永久删除</Button>
        </>}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" className="ice-doc-danger-text" disabled={busy} onClick={() => setForever("all")}>清空回收站</Button>
        <DeleteForeverDialog target={forever} count={forever === "all" ? all.length : forever?.length ?? 0}
          onClose={() => setForever(null)} onDone={() => onSelect(new Set())} />
      </>}
      {selected.size > 0 && view !== "trash" && <>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void run("trash", {}, "已移入回收站")}>移入回收站</Button>
          <span className="ice-doc-batch__grp">
            <Input value={series} maxLength={40} placeholder="系列名" aria-label="批量设置系列" onChange={event => setSeries(event.target.value)} style={{ width: 110 }} />
            <Button size="sm" variant="ghost" disabled={!series.trim() || busy} onClick={() => void run("set_series", { series: series.trim() }, "已设系列")}>设系列</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("clear_series", {}, "已清除系列")}>清除系列</Button>
          </span>
          <span className="ice-doc-batch__grp">
            <input type="date" value={date} aria-label="批量设置计划日期" onChange={event => setDate(event.target.value)} />
            <Button size="sm" variant="ghost" disabled={!date || busy} onClick={() => void run("set_planned", { planned_date: date }, "已排期")}>排期</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("clear_planned", {}, "已取消排期")}>取消排期</Button>
          </span>
          <Button size="sm" variant="ghost" disabled={busy || selected.size < 2 || selected.size > 8}
                  title={selected.size < 2 ? "选 2 到 8 篇文章，合成一篇多图文草稿" : selected.size > 8 ? "多图文最多 8 篇" : "按列表顺序合成多图文草稿，可在对话框里调整"}
                  onClick={() => setGroup(all.filter(id => selected.has(id)))}>合成多图文</Button>
        </>}
      {group && <React.Suspense fallback={null}>
        <WeChatGroupDialog open documentIds={group} onClose={() => setGroup(null)} onDone={() => { setGroup(null); onSelect(new Set()); }} />
      </React.Suspense>}
    </div>
  );
}

function DocumentRow({ item, trashed, selected, onSelect }: { item: DocumentSummary; trashed: boolean; selected: boolean; onSelect: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [forever, setForever] = React.useState(false);
  const act = async (method: string, label: string) => {
    setBusy(true);
    try { await docRpc(method, { document_id: item.document_id }); await invalidateDocuments(); toast.success({ title: label }); }
    catch (error) { toast.error({ title: label + "失败", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const trash = async () => {
    setBusy(true);
    try { await trashDocument(item.document_id, item.title); }
    catch (error) { toast.error({ title: "没有移入回收站", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const state = item.generation_state;
  return (
    <div className={"ice-doc-row-card" + (selected ? " is-selected" : "")}>
      <div className="ice-suggest__check"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`选择「${item.title || "未命名文章"}」`} /></div>
      <button type="button" className="ice-doc-row-card__main" disabled={trashed} onClick={() => void openDocument(item.document_id)}>
        <span className="ice-doc-row-card__title">{item.title || "未命名文章"}</span>
        <span className="ice-doc-row-card__summary">{state === "running" ? "AI 正在后台生成初稿…" : state === "failed" ? "AI 初稿没有完成，可手动写或重新起草" : item.summary || "（空白）"}</span>
        <span className="ice-doc-row-card__meta">
          {state === "running" && <span className="ice-doc-chip is-busy"><Spinner size={10} /> 生成中</span>}
          {state === "failed" && <span className="ice-doc-chip is-bad">生成失败</span>}
          {item.published && <span className="ice-doc-chip is-ok">已登记发布</span>}
          {item.planned_date && !item.published && <span className="ice-doc-chip is-busy">计划 {item.planned_date.slice(5)}</span>}
          <span className="ice-doc-chip">{item.source_label || ORIGIN_LABEL[item.origin]}</span>
          {item.series && <span className="ice-doc-chip">{item.series}{item.episode ? `·${item.episode}` : ""}</span>}
          <span>{item.word_count} 字 · {item.images} 图 · {trashed && item.trashed_at ? `移入回收站于 ${formatTime(item.trashed_at)}` : formatTime(item.updated_at)}</span>
        </span>
      </button>
      <div className="ice-doc-row-card__actions">
        {busy ? <Spinner size={12} /> : trashed
          ? <>
            <Button size="sm" variant="ghost" onClick={() => void act("documents.untrash", "已恢复文章")}>恢复</Button>
            <Button size="sm" variant="ghost" className="ice-doc-danger-text" disabled={item.published || state === "running"}
              title={item.published ? "已登记发布的文章保留发布记录；先在发布记录里撤回登记才能永久删除" : "永久删除，不能恢复"}
              onClick={() => setForever(true)}>永久删除</Button>
          </>
          : <>
            <Button size="sm" variant="ghost" disabled={state === "running"} onClick={() => void act("documents.duplicate", "已复制为新文章")}>复制</Button>
            <Button size="sm" variant="ghost" className="ice-doc-danger-text" disabled={state === "running"}
              title={state === "running" ? "AI 初稿生成完成后才能删除" : "移入回收站，可以恢复"} onClick={() => void trash()}>删除</Button>
          </>}
        <DeleteForeverDialog target={forever ? [item.document_id] : null} count={1} onClose={() => setForever(false)} />
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
  // P1：快速（直接出稿，可两版对照）/ 引导（先在助手里回答几个问题）。
  const [mode, setMode] = React.useState<"quick" | "guided">("quick");
  const [twoVersions, setTwoVersions] = React.useState(false);
  // v3.16：本次起草使用的写作技能；null 表示按公众号默认。
  const [skills, setSkills] = React.useState<SkillBinding | null>(null);
  const [pickSkills, setPickSkills] = React.useState(false);
  const requestId = React.useRef<string | null>(null);
  React.useEffect(() => { if (!open) { setBusy(false); requestId.current = null; } }, [open]);
  // 换模式、版本数或技能等于新请求：不能复用上一个请求标识。
  React.useEffect(() => { requestId.current = null; }, [mode, twoVersions, skills]);
  const ready = readiness === "ready" || readiness === "untested";
  const submit = async () => {
    if (brief.trim().length < 4) return;
    setBusy(true);
    requestId.current ??= crypto.randomUUID().replace(/-/g, "");
    const owner = accountStore.get();
    try {
      if (mode === "guided") {
        await flushAllDirty();
        const started = await docRpc<{ conversation_id: string }>("documents.ai_guided_start", { account_id: owner, brief: brief.trim(), request_id: requestId.current,
          ...(skills ? { skill_binding: skills } : {}) });
        onClose(); setBrief("");
        // 等待期间切了公众号：会话属于原公众号，不能在新公众号里打开它。
        if (accountStore.get() !== owner) { toast.info({ title: "引导式起草已在原公众号开始", detail: "切回原公众号后，在助手的会话列表中继续。" }); return; }
        documentStore.set(null); setWorkspace("assistant"); conversationStore.set(started.conversation_id);
        toast.info({ title: "已在助手中开始引导式起草", detail: "先在提问框里回答几个问题，再生成初稿；满意后点「存为文章」。" });
        return;
      }
      const document = await docRpc<DocumentDetail & { variant_documents?: string[] }>("documents.ai_draft_start",
        { account_id: owner, brief: brief.trim(), request_id: requestId.current, variants: twoVersions ? 2 : 1, ...(skills ? { skill_binding: skills } : {}) });
      void invalidateDocuments(owner);
      onClose(); setBrief("");
      if (document.generation_state === "failed") toast.error({ title: "AI 起草没有启动", detail: String(document.meta.error ?? "请检查模型配置") });
      else toast.info({ title: twoVersions ? "已在后台开始生成两个版本" : "已在后台开始生成",
        detail: twoVersions ? "两版会分别保存为“版本 A / 版本 B”，打开任一版可以对照另一版。你可以继续当前工作。"
          : "完成后自动保存为独立的 AI 初稿，出现在文章列表；你可以继续当前工作。",
        action: { label: "打开", run: () => { if (accountStore.get() === owner) void openDocument(document.document_id);
          else toast.info({ title: "这篇初稿属于另一个公众号", detail: "请先切回原公众号再打开。" }); } } });
    } catch (error) { toast.error({ title: "AI 起草没有启动", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title="AI 起草" width={600}
            description="生成结果会保存为一篇独立的“AI 初稿”，不会覆盖任何已有文章；生成失败会如实标出。"
            footer={<><Button onClick={onClose}>取消</Button>
              <Button variant="primary" loading={busy} disabled={!ready || brief.trim().length < 4} onClick={() => void submit()}>
                {mode === "guided" ? "去助手里回答问题" : twoVersions ? "生成两个版本" : "开始生成"}</Button></>}>
      <div className="ice-doc-form">
        {!ready && <div className="ice-doc-readiness is-bad">还没有可用的写作模型。手动写作不受影响；如需 AI 起草，请先
          <button type="button" className="ice-link-btn" onClick={() => settingsStore.set(true)}>配置模型</button>。</div>}
        <div className="ice-doc-modes" role="radiogroup" aria-label="起草方式">
          <button type="button" role="radio" aria-checked={mode === "quick"} className={mode === "quick" ? "is-on" : ""} onClick={() => setMode("quick")}>
            <strong>快速生成</strong><span>直接写完整初稿，不提问；适合需求已经说清楚的文章</span></button>
          <button type="button" role="radio" aria-checked={mode === "guided"} className={mode === "guided" ? "is-on" : ""} onClick={() => setMode("guided")}>
            <strong>引导式</strong><span>先在助手里回答 2–4 个问题（读者、篇幅、角度…），再出初稿</span></button>
        </div>
        <textarea className="ice-doc-textarea" rows={7} value={brief} maxLength={4000} placeholder="例如：写一篇 1500 字左右的家庭收纳经验分享，面向刚搬家的年轻人，语气轻松，分 4 个小标题。"
                  onChange={event => setBrief(event.target.value)} aria-label="文章需求" />
        {mode === "quick" && <label className="ice-doc-check">
          <input type="checkbox" checked={twoVersions} onChange={event => setTwoVersions(event.target.checked)} />
          同时生成两个版本对照（不同切入角度，各存为一篇；模型调用次数加倍）</label>}
        <div className="ice-doc-row">
          <span className="ice-doc-muted">写作技能：{skills ? "本次自选" : "按公众号默认"}</span>
          <button type="button" className="ice-link-btn" aria-expanded={pickSkills} onClick={() => setPickSkills(value => !value)}>
            {pickSkills ? "收起" : "为这篇选择技能"}</button>
        </div>
        {pickSkills && <SkillPicker value={skills} onChange={setSkills} inheritLabel="按公众号默认" disabled={busy} />}
      </div>
    </Dialog>
  );
}
