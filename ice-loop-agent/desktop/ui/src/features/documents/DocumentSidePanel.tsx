// 文章侧栏：排版（B-02）、版本（A-03）、交付与人工发布登记（B-04/C-05）。
import * as React from "react";
import DOMPurify from "dompurify";

import { Button, Input, SkeletonRows, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { accountStore, useAccountQuery, queryClient, useCurrentAccount } from "../../data/client";
import {
  FONT_SIZES, LINE_HEIGHTS, PARAGRAPH_SPACINGS, PRODUCER_LABEL, docRpc, formatBytes, formatTime, invalidateDocuments,
  type Delivery, type DocStyle, type DocumentDetail, type PublicationRecord, type VersionSummary,
} from "./documentsApi";

type Panel = "style" | "versions" | "delivery";
type Props = {
  panel: Panel; onPanel: (panel: Panel | null) => void; documentId: string; style: DocStyle; onStyle: (patch: Partial<DocStyle>) => void;
  revision: () => number; flush: () => Promise<void>; commitVersion: (note: string) => Promise<{ version_id: string; created: boolean }>;
  unversioned: boolean; onRestored: () => void; detail: DocumentDetail;
};

export function DocumentSidePanel(props: Props) {
  return (
    <div className="ice-doc-side__inner">
      <div className="ice-doc-side__tabs" role="tablist" aria-label="文章侧栏">
        {([["style", "排版"], ["versions", "版本"], ["delivery", "交付与发布"]] as const).map(([value, label]) =>
          <button key={value} type="button" role="tab" aria-selected={props.panel === value} onClick={() => props.onPanel(value)}>{label}</button>)}
        <span style={{ flex: 1 }} />
        <button type="button" className="ice-link-btn" onClick={() => props.onPanel(null)} aria-label="收起侧栏">收起</button>
      </div>
      <div className="ice-doc-side__body">
        {props.panel === "style" && <StylePanel {...props} />}
        {props.panel === "versions" && <VersionsPanel {...props} />}
        {props.panel === "delivery" && <DeliveryPanel {...props} />}
      </div>
    </div>
  );
}

const BRAND_PRESETS = ["#2563eb", "#0f766e", "#b91c1c", "#7c3aed", "#c2410c", "#111827"];

function StylePanel({ style, onStyle }: Props) {
  return (
    <div className="ice-doc-form">
      <p className="ice-doc-muted">主题：简洁（首期唯一主题）。设置随文章保存，并用于复制和导出。</p>
      <label>品牌色
        <span className="ice-doc-row">
          <input type="color" value={style.brandColor} aria-label="品牌色" onChange={event => onStyle({ brandColor: event.target.value.toLowerCase() })} />
          {BRAND_PRESETS.map(color => <button key={color} type="button" className="ice-doc-swatch" style={{ background: color }}
            aria-label={"品牌色 " + color} aria-pressed={style.brandColor === color} onClick={() => onStyle({ brandColor: color })} />)}
        </span>
      </label>
      <label>正文字号
        <select aria-label="正文字号" value={style.fontSize} onChange={event => onStyle({ fontSize: Number(event.target.value) })}>
          {FONT_SIZES.map(size => <option key={size} value={size}>{size}px</option>)}
        </select>
      </label>
      <label>行距
        <select aria-label="行距" value={style.lineHeight} onChange={event => onStyle({ lineHeight: Number(event.target.value) })}>
          {LINE_HEIGHTS.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>段落间距
        <select aria-label="段落间距" value={style.paragraphSpacing} onChange={event => onStyle({ paragraphSpacing: Number(event.target.value) })}>
          {PARAGRAPH_SPACINGS.map(value => <option key={value} value={value}>{value}px</option>)}
        </select>
      </label>
      <p className="ice-doc-muted">局部样式（颜色、字号、对齐）在正文工具栏中设置。未在此列出的样式不会进入交付内容。</p>
    </div>
  );
}

function VersionsPanel({ documentId, commitVersion, unversioned, revision, flush, onRestored, detail }: Props) {
  const versions = useAccountQuery<VersionSummary[]>("documents.versions", { document_id: documentId }, { staleTime: 0 });
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ version_id: string; markdown: string } | null>(null);
  const account = useCurrentAccount();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.versions"] });
  const save = async () => {
    setBusy("save");
    try {
      const result = await commitVersion(note.trim());
      toast.success({ title: result.created ? "已保存为新版本" : "内容与最新版本相同，未重复保存" });
      setNote(""); void refresh();
    } catch (error) { toast.error({ title: "版本没有保存", detail: (error as Error).message }); }
    finally { setBusy(null); }
  };
  const restore = async (version: VersionSummary) => {
    setBusy(version.version_id);
    try {
      await flush();
      await docRpc("documents.restore", { document_id: documentId, version_id: version.version_id, base_revision: revision() });
      toast.success({ title: "已恢复到所选版本", detail: "恢复前的内容已自动保存为一个版本，可再恢复回来。" });
      void invalidateDocuments(); onRestored();
    } catch (error) { toast.error({ title: "恢复失败", detail: (error as Error).message }); }
    finally { setBusy(null); }
  };
  const show = async (version: VersionSummary) => {
    if (preview?.version_id === version.version_id) { setPreview(null); return; }
    try { setPreview(await docRpc<{ version_id: string; markdown: string }>("documents.version", { document_id: documentId, version_id: version.version_id })); }
    catch (error) { toast.error({ title: "无法读取版本", detail: (error as Error).message }); }
  };
  return (
    <div className="ice-doc-form">
      <div className="ice-doc-row">
        <Input value={note} maxLength={200} placeholder={unversioned ? "版本说明（可选）" : "当前内容已是最新版本"} aria-label="版本说明"
               onChange={event => setNote(event.target.value)} style={{ flex: 1 }} />
        <Button variant="primary" size="sm" loading={busy === "save"} onClick={() => void save()}>保存版本</Button>
      </div>
      <p className="ice-doc-muted">输入会自动保存为工作副本；版本是可恢复的固定快照。交付和登记发布都绑定版本。</p>
      {versions.isLoading && <SkeletonRows rows={4} />}
      {versions.error && <ErrorNote error={versions.error} onRetry={() => versions.refetch()} retryLabel="重新读取版本" />}
      <ol className="ice-doc-versions">
        {(versions.data ?? []).map((version, index) => (
          <li key={version.version_id}>
            <div className="ice-doc-row">
              <strong>{PRODUCER_LABEL[version.producer] ?? version.producer}</strong>
              {index === 0 && <span className="ice-doc-chip">最新</span>}
              {version.published && <span className="ice-doc-chip is-ok">已登记发布</span>}
              <span style={{ flex: 1 }} />
              <span className="ice-doc-muted">{formatTime(version.created_at)}</span>
            </div>
            <div className="ice-doc-muted">{version.note} · {version.word_count} 字 · {version.images} 图</div>
            <div className="ice-doc-row">
              <button type="button" className="ice-link-btn" onClick={() => void show(version)}>{preview?.version_id === version.version_id ? "收起" : "查看"}</button>
              {(index > 0 || unversioned) && <button type="button" className="ice-link-btn" disabled={busy !== null} onClick={() => void restore(version)}>
                {busy === version.version_id ? "恢复中…" : "恢复到此版本"}</button>}
            </div>
            {preview?.version_id === version.version_id && <pre className="ice-doc-version-preview">{preview.markdown}</pre>}
          </li>
        ))}
      </ol>
      <ImportHistory documentId={documentId} imports={detail.imports} flush={flush} revision={revision} onReload={onRestored} />
    </div>
  );
}

function ImportHistory({ documentId, imports, flush, revision, onReload }: {
  documentId: string; imports: DocumentDetail["imports"]; flush: Props["flush"]; revision: Props["revision"]; onReload: () => void;
}) {
  const [source, setSource] = React.useState<{ import_id: string; original: string } | null>(null);
  const [rebuild, setRebuild] = React.useState<{ import_id: string; mode: "adapt" | "text" } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const show = async (importId: string) => {
    setBusy(true);
    try { setSource(await docRpc("documents.import_original", { document_id: documentId, import_id: importId })); }
    catch (error) { toast.error({ title: "原件读取失败", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const convert = async () => {
    if (!rebuild) return;
    setBusy(true);
    try {
      await flush();
      await docRpc("documents.reconvert", { document_id: documentId, import_id: rebuild.import_id, mode: rebuild.mode, base_revision: revision() });
      void invalidateDocuments(); onReload();
      toast.success({ title: "已从原件重新转换", detail: "转换前的文章已保留为版本，可在版本历史中恢复。" });
    } catch (error) { toast.error({ title: "没有重新转换", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  if (!imports.length) return null;
  return <section className="ice-doc-form" aria-label="导入报告与原件">
    <h3>导入报告与原件</h3>
    {imports.map(item => <div key={item.import_id} className="ice-doc-form">
      <div>{formatTime(item.created_at)} · {item.kind}</div>
      {item.report.images && <p className="ice-doc-muted">
        {item.report.paragraphs} 段；图片 {item.report.images.imported}/{item.report.images.total}；
        {item.report.images.missing.length} 张缺图；{item.report.islands.length} 个未支持模块。
        {item.report.images.missing.map((image, index) => <span key={index} style={{ display: "block" }}>缺图：{image.alt || "未命名"} · {image.reason}</span>)}
        {item.report.islands.map((island, index) => <span key={index} style={{ display: "block" }}>原件：{island.reason} · {island.preview}</span>)}
        {Object.entries(item.report.styles.ignored).map(([name, count]) => <span key={name} style={{ display: "block" }}>未映射样式：{name} × {count}</span>)}
        {Object.entries(item.report.dropped).map(([name, count]) => <span key={name} style={{ display: "block" }}>已移除：{name} × {count}</span>)}
      </p>}
      <div className="ice-doc-row">
        <Button size="sm" disabled={busy} onClick={() => void show(item.import_id)}>查看原始内容</Button>
        {item.kind === "html" && <>
          <Button size="sm" disabled={busy} onClick={() => setRebuild({ import_id: item.import_id, mode: "text" })}>从原件改为仅文字</Button>
          <Button size="sm" disabled={busy} onClick={() => setRebuild({ import_id: item.import_id, mode: "adapt" })}>从原件适配样式</Button>
        </>}
      </div>
      {source?.import_id === item.import_id && <pre className="ice-doc-version-preview" aria-label="原始内容（只读）">{source.original}</pre>}
    </div>)}
    {rebuild && <div className="ice-doc-form" role="alert">
      <p>将用所选原件重新生成整篇正文，之后添加的文字和图片不会合入。当前内容会先保存为版本，之后可从历史恢复。</p>
      <div className="ice-doc-row"><Button size="sm" variant="primary" loading={busy} onClick={() => void convert()}>确认重新转换</Button>
        <Button size="sm" disabled={busy} onClick={() => setRebuild(null)}>取消</Button></div>
    </div>}
  </section>;
}

function DeliveryPanel({ documentId, revision, flush, detail }: Props) {
  const [delivery, setDelivery] = React.useState<Delivery | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [exported, setExported] = React.useState<{ version_id: string; destination: string; complete: boolean; images: number; missing_images: number } | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const publications = useAccountQuery<PublicationRecord[]>("publications.list", { document_id: documentId }, { staleTime: 0 });
  const build = React.useCallback(async () => {
    setBusy("build"); setError(null);
    try {
      await flush();
      setDelivery(await docRpc<Delivery>("documents.render_delivery", { document_id: documentId, base_revision: revision() }));
    } catch (problem) { setError(problem); }
    finally { setBusy(null); }
  }, [documentId, flush, revision]);
  React.useEffect(() => { void build(); }, [build]);
  const safeHtml = React.useMemo(() => delivery ? DOMPurify.sanitize(delivery.html, { ADD_DATA_URI_TAGS: ["img"], FORBID_TAGS: ["style", "script"] }) : "", [delivery]);

  const copy = async (mode: "html" | "text") => {
    if (!delivery) return;
    const bridge = window.ice?.copyDocument as undefined | ((params: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; delivery_id?: string }>);
    setBusy("copy-" + mode);
    try {
      if (typeof bridge !== "function") throw new Error("请在桌面应用中复制（需要写入系统剪贴板）");
      const result = await bridge({ document_id: documentId, version_id: delivery.version_id, account_id: accountStore.get(), mode });
      if (!result.ok) throw new Error(result.message || "剪贴板写入未确认");
      setCopied(delivery.version_id);
      toast.success({ title: mode === "html" ? "已复制图文，可粘贴到公众号编辑器" : "已复制纯文本",
        detail: delivery.complete ? `对应版本 ${formatTime(delivery.version_created_at)}；复制不等于已发布。` : "仍有未处理的问题，请在粘贴后检查。" });
    } catch (problem) { toast.error({ title: "复制失败", detail: (problem as Error).message }); }
    finally { setBusy(null); }
  };
  const exportBundle = async () => {
    if (!delivery) return;
    const bridge = window.ice;
    if (!bridge?.chooseExportDir) { toast.warning({ title: "此运行环境不支持选择导出目录" }); return; }
    setBusy("export");
    let destination: string | null = null, done = false;
    try {
      destination = await bridge.chooseExportDir();
      if (!destination) return;
      const result = await docRpc<{ version_id: string; destination: string; complete: boolean; images: number; missing_images: number }>("documents.export_bundle",
        { document_id: documentId, version_id: delivery.version_id, destination });
      done = true;
      setExported(result);
      (result.complete ? toast.success : toast.warning)({ title: result.complete ? "图文包已导出" : "已导出草稿包，仍有待处理项",
        detail: `${result.images} 张原图已按正文顺序编号；导出不等于已发布。` });
    } catch (problem) { toast.error({ title: "导出失败", detail: (problem as Error).message }); }
    finally {
      if (destination && !done) try { await bridge.cancelExportDir?.(destination); } catch { /* 已失效的批准无需处理 */ }
      setBusy(null);
    }
  };
  const jump = (blockId: string) => {
    if (!blockId) return;
    const element = document.querySelector(`.ice-doc-prose [data-bid="${CSS.escape(blockId)}"]`) as HTMLElement | null;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    element?.classList.add("ice-doc-flash"); window.setTimeout(() => element?.classList.remove("ice-doc-flash"), 1200);
  };
  const delivered = Boolean(delivery && ((detail.deliveries ?? []).some(record => record.version_id === delivery.version_id)
    || exported?.version_id === delivery.version_id || copied === delivery.version_id));

  return (
    <div className="ice-doc-form">
      <div className="ice-doc-row">
        <Button size="sm" loading={busy === "build"} onClick={() => void build()}>刷新预览</Button>
        {delivery && <span className="ice-doc-muted">版本 {formatTime(delivery.version_created_at)}</span>}
      </div>
      {error != null && <ErrorNote error={error} onRetry={() => void build()} retryLabel="重新生成预览" />}
      {!delivery && busy === "build" && <div className="ice-doc-center"><Spinner /></div>}
      {delivery && <>
        <div className={"ice-doc-readiness" + (delivery.complete ? " is-ok" : " is-bad")}>
          {delivery.complete ? "可交付：没有阻断问题" : `有 ${delivery.issues.filter(i => i.severity === "error").length} 个问题需要处理后才算完整`}
        </div>
        {delivery.issues.length > 0 && <ul className="ice-doc-issues">
          {delivery.issues.map((issue, index) => <li key={index} data-severity={issue.severity}>
            <button type="button" className="ice-link-btn" disabled={!issue.block_id} onClick={() => jump(issue.block_id)}>{issue.message}</button></li>)}
        </ul>}
        <div className="ice-doc-row ice-doc-actions">
          <Button variant="primary" size="sm" loading={busy === "copy-html"} onClick={() => void copy("html")}>复制到公众号</Button>
          <Button size="sm" loading={busy === "copy-text"} onClick={() => void copy("text")}>复制纯文本</Button>
          <Button size="sm" loading={busy === "export"} onClick={() => void exportBundle()}>导出图文包</Button>
        </div>
        {exported && <div className="ice-doc-muted">已导出到 {exported.destination}
          {window.ice?.openExportFolder && <> · <button type="button" className="ice-link-btn" onClick={() => void window.ice?.openExportFolder?.(exported.destination)}>打开文件夹</button></>}</div>}
        {delivery.images.length > 0 && <details className="ice-doc-images">
          <summary>图片顺序（{delivery.images.length}）</summary>
          <ol>{delivery.images.map(image => <li key={image.order}>{image.missing ? "缺失" : image.file_name} {image.caption && `· ${image.caption}`}
            {!image.missing && <span className="ice-doc-muted"> · {image.width}×{image.height} · {formatBytes(image.size)}</span>}</li>)}</ol>
          <p className="ice-doc-muted">导出包中的图片为原图字节，按正文顺序编号；公众号后台的实际上传限制以实测为准。</p>
        </details>}
        <div className="ice-doc-phone" aria-label="公众号排版预览">
          <div className="ice-doc-phone__title">{delivery.title}</div>
          <div dangerouslySetInnerHTML={{ __html: safeHtml }} />
        </div>
      </>}
      <PublicationForm documentId={documentId} delivery={delivery} delivered={delivered} records={publications.data ?? []}
                       onChanged={() => publications.refetch()} />
    </div>
  );
}

function PublicationForm({ documentId, delivery, delivered, records, onChanged }: {
  documentId: string; delivery: Delivery | null; delivered: boolean; records: PublicationRecord[]; onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [when, setWhen] = React.useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    if (!delivery) return;
    setBusy(true);
    try {
      await docRpc("publications.register", { document_id: documentId, version_id: delivery.version_id, url: url.trim(),
        published_at: new Date(when).toISOString(), note: note.trim() });
      toast.success({ title: "已登记发布", detail: "登记绑定当前交付版本；之后的修改不会改写这次发布记录。" });
      setOpen(false); setUrl(""); setNote(""); onChanged(); void invalidateDocuments();
    } catch (error) { toast.error({ title: "登记失败", detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const withdraw = async (record: PublicationRecord) => {
    try { await docRpc("publications.withdraw", { record_id: record.record_id }); onChanged(); void invalidateDocuments(); }
    catch (error) { toast.error({ title: "撤销登记失败", detail: (error as Error).message }); }
  };
  return (
    <section className="ice-doc-publish">
      <h3>人工发布登记</h3>
      <p className="ice-doc-muted">复制或导出不会自动标记为已发布。在公众号后台发布后，在这里登记链接和时间（用户声明，不自动核验）。</p>
      {records.map(record => <div key={record.record_id} className={"ice-doc-record" + (record.state === "withdrawn" ? " is-withdrawn" : "")}>
        <div className="ice-doc-row"><strong>{formatTime(record.published_at)}</strong>
          {record.state === "withdrawn" && <span className="ice-doc-chip">已撤销登记</span>}<span style={{ flex: 1 }} />
          {record.state === "active" && <button type="button" className="ice-link-btn" onClick={() => void withdraw(record)}>撤销登记</button>}</div>
        {record.url && <div className="ice-doc-muted" title={record.url}>{record.url}</div>}
        {record.note && <div className="ice-doc-muted">{record.note}</div>}
      </div>)}
      {!open ? <Button size="sm" disabled={!delivery || !delivered} onClick={() => setOpen(true)}
                       title={delivered ? "" : "请先复制或导出这个版本"}>登记一次发布</Button>
        : <div className="ice-doc-form">
          <label>文章链接（可留空）<Input value={url} placeholder="https://mp.weixin.qq.com/s/…" onChange={event => setUrl(event.target.value)} /></label>
          <label>发布时间<input type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></label>
          <label>备注<Input value={note} maxLength={500} onChange={event => setNote(event.target.value)} /></label>
          <div className="ice-doc-row"><Button size="sm" variant="primary" loading={busy} onClick={() => void submit()}>确认登记</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>取消</Button></div>
        </div>}
      {!delivered && <p className="ice-doc-muted">这个文章还没有复制或导出过；登记需要先交付一个版本。</p>}
    </section>
  );
}
