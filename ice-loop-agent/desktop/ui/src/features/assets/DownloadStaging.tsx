// C2：内嵌浏览器下载的待归档箱。下载只暂存，不默认采纳；用户明确选择图位后才绑定。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button } from "../../components/ui";
import { toast } from "../../components/toast";
import { rpc, useAccountQuery, type RpcError } from "../../data/client";

type DownloadRow = {
  download_id: string; file_path: string; file_sha256: string; mime: string;
  size: number; status: string; bound_slot: string | null; created_at: string;
};

type SlotOption = { figure_no: number; caption?: string; kind?: string };

const STATUS_LABEL: Record<string, string> = {
  pending: "待归档", bound: "已绑定图位", discarded: "已判定不采用",
};

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DownloadStaging() {
  const list = useAccountQuery<{ downloads: DownloadRow[] }>("downloads.list", {},
    { refetchInterval: 8_000 });
  const rows = list.data?.downloads ?? [];
  const pending = rows.filter(row => row.status === "pending").length;
  const [open, setOpen] = React.useState(true);

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
                      style={{ overflow: "hidden" }}>
            {list.error && (
              <div role="alert" className="ice-error-text" style={{ fontSize: "var(--ice-font-size-sm)" }}>
                待归档加载失败：{(list.error as RpcError).message}
                <button type="button" className="ice-link-btn" style={{ marginLeft: 8 }}
                        onClick={() => list.refetch()}>重试</button>
              </div>
            )}
            {!list.isLoading && rows.length === 0 && (
              <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
                在内嵌浏览器下载的图片会出现在这里。下载不会自动成为配图，需要你选择图位后才采纳。
              </div>
            )}
            <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {rows.map(row => (
                <DownloadItem key={row.download_id} row={row} onChanged={() => list.refetch()} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function DownloadItem({ row, onChanged }: { row: DownloadRow; onChanged: () => Promise<unknown> }) {
  const jobs = useAccountQuery<Array<{ job_id: string; topic: string; final_title: string | null; state: string }>>(
    "jobs.list", { visibility: "active" }, { enabled: row.status === "pending" });
  const [jobId, setJobId] = React.useState("");
  const [figureNo, setFigureNo] = React.useState<number | null>(null);
  const [slots, setSlots] = React.useState<SlotOption[] | null>(null);
  const [busy, setBusy] = React.useState<"bind" | "discard" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!jobId) { setSlots(null); setFigureNo(null); return; }
    let cancelled = false;
    rpc<{ slots?: SlotOption[] }>("jobs.get", { job_id: jobId })
      .then(data => { if (!cancelled) { setSlots(data.slots ?? []); setFigureNo(null); } })
      .catch(err => { if (!cancelled) setError((err as RpcError).message); });
    return () => { cancelled = true; };
  }, [jobId]);

  const bind = async () => {
    if (!jobId || figureNo === null || busy) return;
    setBusy("bind"); setError(null);
    try {
      await rpc("downloads.bind", { download_id: row.download_id, slot_label: `${jobId}#fig${figureNo}`,
                                    job_id: jobId, figure_no: figureNo });
      await onChanged();
      toast.success({ title: "已绑定到图位", detail: "图片已进入该图位的候选并采纳" });
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(null); }
  };
  const discard = async () => {
    if (busy) return;
    setBusy("discard"); setError(null);
    try {
      await rpc("downloads.bind", { download_id: row.download_id, slot_label: null });
      await onChanged();
      toast.success({ title: "已判定不采用", detail: "这张下载不会成为任何图位的候选" });
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="ice-card ice-card--compact" style={{ fontSize: "var(--ice-font-size-sm)", gap: 4, padding: "6px 10px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={row.file_path}>{fileName(row.file_path)}</strong>
        <span style={{ color: "var(--ice-text-secondary)", flexShrink: 0 }}>{formatSize(row.size)}</span>
        <span className={"ice-badge" + (row.status === "bound" ? " ice-badge--success"
                                        : row.status === "pending" ? " ice-badge--warning" : "")}>
          {STATUS_LABEL[row.status] ?? row.status}
        </span>
      </div>
      <div style={{ color: "var(--ice-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
           title={row.file_sha256}>
        {row.bound_slot ? `图位 ${row.bound_slot} · ` : ""}摘要 {row.file_sha256.slice(0, 12)}
      </div>
      {row.status === "pending" && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select aria-label="选择文章" value={jobId} onChange={event => setJobId(event.target.value)}
                  style={{ height: 28, borderRadius: 6, border: "1px solid var(--ice-border)", background: "var(--ice-surface)", maxWidth: 180 }}>
            <option value="">选择文章…</option>
            {(jobs.data ?? []).map(job => (
              <option key={job.job_id} value={job.job_id}>{job.final_title || job.topic}</option>
            ))}
          </select>
          <select aria-label="选择图位" value={figureNo ?? ""} disabled={!slots}
                  onChange={event => setFigureNo(event.target.value ? Number(event.target.value) : null)}
                  style={{ height: 28, borderRadius: 6, border: "1px solid var(--ice-border)", background: "var(--ice-surface)", maxWidth: 160 }}>
            <option value="">选择图位…</option>
            {(slots ?? []).map(slot => (
              <option key={slot.figure_no} value={slot.figure_no}>
                图{slot.figure_no}{slot.caption ? " · " + slot.caption.slice(0, 16) : ""}
              </option>
            ))}
          </select>
          <Button size="sm" variant="primary" loading={busy === "bind"}
                  disabled={busy !== null || !jobId || figureNo === null}
                  title="绑定后该图片成为此图位的采纳候选" onClick={bind}>绑定图位</Button>
          <Button size="sm" variant="ghost" loading={busy === "discard"} disabled={busy !== null}
                  title="判定不属于任何图位，不产生候选" onClick={discard}>不采用</Button>
        </div>
      )}
      {error && <div role="alert" className="ice-error-text">{error}</div>}
    </div>
  );
}
