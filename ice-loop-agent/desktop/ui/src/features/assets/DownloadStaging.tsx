// C2/D 批（2026-10-22 迭代）：内嵌浏览器下载的待归档箱。下载只暂存，不默认采纳；
// 用户明确选择文章与图位并确认后「绑定并采纳」（downloads.bind 的真实语义：
// 导入正式资源+候选并采纳；不采用只是逻辑状态，不删除磁盘文件）。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { ErrorNote } from "../../components/ErrorNote";
import { Button } from "../../components/ui";
import { accountStore, flushAllDirty, queryClient, rpc, useAccountQuery, useCurrentAccount } from "../../data/client";
import { refreshAfterWrite } from "../../data/receipts";
import { CopyButton } from "../../components/CopyButton";
import { usePaneActive } from "../../app/PaneActivity";

type DownloadRow = {
  download_id: string; file_path: string; file_sha256: string; mime: string;
  size: number; status: string; bound_slot: string | null; created_at: string;
};

type SlotOption = { figure_no: number; caption?: string; kind?: string; valid?: boolean };

const STATUS_LABEL: Record<string, string> = {
  pending: "待归档", bound: "已绑定图位", discarded: "已判定不采用",
};
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部状态" }, { value: "pending", label: "待归档" },
  { value: "bound", label: "已绑定" }, { value: "discarded", label: "不采用" },
];

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DownloadStaging() {
  const active = usePaneActive();
  const account = useCurrentAccount();
  const [open, setOpen] = React.useState(true);
  const openRef = React.useRef(open); openRef.current = open;
  // D4：收起后暂停轮询，不再保持无意义的后台读取。
  const list = useAccountQuery<{ downloads: DownloadRow[] }>("downloads.list", {},
    { enabled: active, refetchInterval: () => (openRef.current ? 8_000 : false) });
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const rows = list.data?.downloads ?? [];
  const pending = rows.filter(row => row.status === "pending").length;
  const needle = query.trim().toLowerCase();
  const visible = rows.filter(row =>
    (statusFilter === "all" || row.status === statusFilter)
    && (!needle || fileName(row.file_path).toLowerCase().includes(needle)
        || (row.mime || "").toLowerCase().includes(needle)
        || (row.bound_slot || "").toLowerCase().includes(needle)));

  return (
    <section aria-label="下载待归档" style={{ display: "grid", gap: 6, padding: "var(--ice-space-2) var(--ice-space-3)",
                                           borderBottom: "1px solid var(--ice-border)" }}>
      <button type="button" className="ice-link-btn ice-link-btn--muted" aria-expanded={open}
              onClick={() => setOpen(value => !value)}
              style={{ justifySelf: "start", display: "inline-flex", gap: 6, alignItems: "center" }}>
        <motion.span aria-hidden animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.16 }}
                     style={{ display: "inline-block" }}>▸</motion.span>
        下载待归档
        {pending > 0 && <span className="ice-badge ice-badge--warning">{pending} 张待选择图位</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="downloads" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
                      style={{ overflow: "hidden", display: "grid", gap: 6 }}>
            {list.error && <ErrorNote error={list.error} onRetry={()=>list.refetch()} retryLabel="重新读取下载列表" />}
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input type="search" aria-label="搜索下载文件名" placeholder="搜索文件名" maxLength={120}
                     value={query} onChange={event => setQuery(event.target.value)}
                     style={{ flex: 1, minWidth: 90, height: 26, borderRadius: 6, border: "1px solid var(--ice-border)",
                              background: "var(--ice-surface)", padding: "0 8px", fontSize: "var(--ice-font-size-sm)" }} />
              <select aria-label="下载状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}
                      style={{ height: 26, borderRadius: 6, border: "1px solid var(--ice-border)", background: "var(--ice-surface)",
                               fontSize: "var(--ice-font-size-sm)" }}>
                {STATUS_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            {/* 范围说明：后端只返回最近 100 条，本页统计不冒充全库。 */}
            <Button size="sm" variant="ghost" style={{justifySelf:"start"}} loading={list.isFetching} onClick={()=>void list.refetch()}>刷新下载列表</Button>
            <div role="status" style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
              显示 {visible.length}/{rows.length} 条 · 列表为最近下载（最多 100 条）
            </div>
            {!list.isLoading && !list.error && rows.length === 0 && (
              <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
                在内嵌浏览器下载的图片会出现在这里。下载不会自动成为配图，需要你选择图位后才采纳。
              </div>
            )}
            {!list.isLoading && rows.length > 0 && visible.length === 0 && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--ice-font-size-sm)",
                            color: "var(--ice-text-secondary)" }}>
                没有匹配的下载。
                <button type="button" className="ice-link-btn" onClick={() => { setStatusFilter("all"); setQuery(""); }}>清除筛选</button>
              </div>
            )}
            <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {visible.map(row => (
                <DownloadItem key={account+":"+row.download_id} row={row} onChanged={() => list.refetch({ throwOnError: true })} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function DownloadItem({ row, onChanged }: { row: DownloadRow; onChanged: () => Promise<unknown> }) {
  const account = useCurrentAccount();
  const jobs = useAccountQuery<Array<{ job_id: string; topic: string; final_title: string | null; state: string }>>(
    "jobs.list", { visibility: "active" }, { enabled: row.status === "pending" });
  const [jobId, setJobId] = React.useState("");
  const [figureNo, setFigureNo] = React.useState<number | null>(null);
  const target = useAccountQuery<{job:{job_id:string};article:{series:string;episode:number;spec:{account_id:string}};slots:SlotOption[]}>(
    "jobs.get", {job_id:jobId}, {enabled:Boolean(jobId)&&row.status==="pending",staleTime:0,gcTime:0});
  const targetData = target.data?.job.job_id===jobId && target.data.article.spec.account_id===account ? target.data : null;
  const slots = targetData?.slots ?? null;
  const selectionVersion = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [busy, setBusy] = React.useState<"bind" | "discard" | null>(null);
  const acknowledged = React.useRef(false);
  const [saved, setSaved] = React.useState(false);
  const busyRef = React.useRef(false); // D3：同步防重——同 tick 重复点击不能重复 bind
  const [error, setError] = React.useState<unknown>(null);
  const selectedSlot = slots?.find(slot => slot.figure_no === figureNo) ?? null;

  // D2：提交前明确显示目标（账号域、文章、图号与用途）；目标已有有效图片时提示会替换。
  const targetJob = jobs.data?.find(job => job.job_id === jobId);
  const targetSummary = jobId && selectedSlot
    ? `${targetJob ? (targetJob.final_title || targetJob.topic) : jobId} · 图${figureNo}${selectedSlot.caption ? `（${selectedSlot.caption}）` : ""}`
    : null;
  const replacesValidImage = selectedSlot?.valid === true;
  const canBind = Boolean(targetData && selectedSlot && typeof selectedSlot.valid==='boolean' && !target.isFetching && !target.error);
  const changeTarget = (value:string) => {
    if(busyRef.current)return;
    selectionVersion.current++;setFigureNo(null);setJobId(value);setError(null);
  };
  const refreshTarget = async () => {
    await Promise.all([
      onChanged(),
      queryClient.invalidateQueries({queryKey:['ice',account,'jobs.get',{job_id:jobId}]},{throwOnError:true}),
      queryClient.invalidateQueries({queryKey:['ice',account,'articles.delivery_snapshot']},{throwOnError:true}),
      queryClient.invalidateQueries({queryKey:['ice',account,'resources.list']},{throwOnError:true}),
    ]);
  };

  const bind = async () => {
    if (!jobId || figureNo === null || !canBind || acknowledged.current || busyRef.current) return;
    busyRef.current = true;
    setBusy("bind"); setError(null);
    const version=selectionVersion.current;
    try {
      await flushAllDirty();
      if(!mounted.current||version!==selectionVersion.current)throw Error("目标已变化，请重新核对文章与图位");
      if (accountStore.get() !== account) throw Error("公众号已切换，请在原公众号完成绑定");
      await rpc("downloads.bind", { download_id: row.download_id, slot_label: `${jobId}#fig${figureNo}`,
                                    job_id: jobId, figure_no: figureNo });
      acknowledged.current=true;if(mounted.current)setSaved(true);
      // D3：写已成功（导入候选并采纳）；列表刷新失败单独提示，不重复 bind。
      if(!mounted.current||accountStore.get()!==account)return;
      await refreshAfterWrite("下载绑定", refreshTarget);
    } catch (err) { if(mounted.current&&accountStore.get()===account)setError(err); }
    finally { busyRef.current = false; if(mounted.current)setBusy(null); }
  };
  const discard = async () => {
    if (busyRef.current || acknowledged.current) return;
    busyRef.current = true;
    setBusy("discard"); setError(null);
    try {
      if (accountStore.get() !== account) throw Error("公众号已切换，请在原公众号操作");
      await rpc("downloads.bind", { download_id: row.download_id, slot_label: null });
      acknowledged.current=true;if(mounted.current)setSaved(true);
      if(!mounted.current||accountStore.get()!==account)return;
      await refreshAfterWrite("下载归档判定", () => onChanged());
    } catch (err) { if(mounted.current&&accountStore.get()===account)setError(err); }
    finally { busyRef.current = false; if(mounted.current)setBusy(null); }
  };

  return (
    <div data-download-id={row.download_id} className="ice-card ice-card--compact" style={{ fontSize: "var(--ice-font-size-sm)", gap: 4, padding: "6px 10px" }}>
      {/* data-download-id：原生验收固定“同一行”身份（R1：按可变按钮文字选择会跳到另一行同名按钮） */}
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0, flexWrap:"wrap" }}>
        <strong style={{ flex:"1 1 100px", minWidth:0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={row.file_path}>{fileName(row.file_path)}</strong>
        <span style={{ color: "var(--ice-text-secondary)", flexShrink: 0 }}>{formatSize(row.size)}</span>
        <span style={{ color: "var(--ice-text-secondary)", flexShrink: 0 }}>{row.mime || "未知类型"}</span>
        <span style={{whiteSpace:"nowrap",flexShrink:0}} className={"ice-badge" + (row.status === "bound" ? " ice-badge--success"
                                        : row.status === "pending" ? " ice-badge--warning" : "")}>
          {STATUS_LABEL[row.status] ?? row.status}
        </span>
        <span style={{ color: "var(--ice-text-secondary)", flexShrink: 0, marginLeft: "auto" }}
              title={row.created_at}>{new Date(row.created_at).toLocaleDateString("zh-CN")}</span>
      </div>
      <div style={{ color: "var(--ice-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}
           title={`文件摘要 SHA-256（用于校验文件内容，不代表图片视觉分析结果）：${row.file_sha256}`}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {row.bound_slot ? `已绑定到 ${row.bound_slot}（可在对应文章的配图工作台核对） · ` : ""}文件摘要 {row.file_sha256.slice(0, 12)}
        </span>
        <CopyButton text={row.file_path} label="复制完整路径" successLabel="路径已复制" />
      </div>
      {row.status === "pending" && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select aria-label="选择文章" value={jobId} disabled={busy!==null || saved} onChange={event => changeTarget(event.target.value)}
                    style={{ height: 28, borderRadius: 6, border: "1px solid var(--ice-border)", background: "var(--ice-surface)", maxWidth: 180 }}>
              <option value="">选择文章…</option>
              {(jobs.data ?? []).map(job => (
                <option key={job.job_id} value={job.job_id}>{job.final_title || job.topic}</option>
              ))}
            </select>
            <select aria-label="选择图位" value={figureNo ?? ""} disabled={!slots || target.isFetching || Boolean(target.error) || busy!==null || saved}
                    onChange={event => {if(busyRef.current)return;selectionVersion.current++;setFigureNo(event.target.value ? Number(event.target.value) : null);}}
                    style={{ height: 28, borderRadius: 6, border: "1px solid var(--ice-border)", background: "var(--ice-surface)", maxWidth: 160 }}>
              <option value="">选择图位…</option>
              {(slots ?? []).map(slot => (
                <option key={slot.figure_no} value={slot.figure_no}>
                  图{slot.figure_no}{slot.caption ? " · " + slot.caption.slice(0, 16) : ""}
                </option>
              ))}
            </select>
          </div>
          {jobId && target.isFetching && <p role="status">正在核对目标文章的图位…</p>}
          {target.error && <ErrorNote error={target.error} onRetry={()=>target.refetch()} retryLabel="重新读取目标图位" />}
          {targetSummary && (
            <div role="status" style={{ color: "var(--ice-text-secondary)" }}>
              将绑定并采纳到：{targetSummary}{targetData ? ` · ${targetData.article.series}/${targetData.article.episode}` : ""}
              {replacesValidImage && <span className="ice-error-text" style={{ display: "block" }}>
                该图位已有有效图片；绑定并采纳后会替换当前选用（旧候选保留在候选列表，可再改回）。</span>}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Button size="sm" variant="primary" loading={busy === "bind"}
                    disabled={busy !== null || saved || !canBind}
                    title="downloads.bind 的真实语义：导入为该图位候选并采纳（替换当前选用）" onClick={bind}>绑定并采纳</Button>
            <Button size="sm" variant="ghost" loading={busy === "discard"} disabled={busy !== null || saved}
                    title="不采用只是当前下载箱的逻辑状态：文件保留在下载位置，不删除磁盘文件，也不会成为任何图位的候选" onClick={discard}>不采用</Button>
          </div>
        </div>
      )}
      {saved && row.status==='pending' && <p role="status">归档操作已保存，请刷新列表核对；无需再次提交。</p>}
      {error != null && <ErrorNote error={error} note="未完成的选择已保留，请核对当前账号和目标后重试。" />}
    </div>
  );
}
