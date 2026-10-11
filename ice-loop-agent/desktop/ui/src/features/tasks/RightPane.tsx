// 右栏（M2-07 行动区基础）：制作任务列表（真实 jobs.list）+ 文章/审阅占位说明。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, EmptyState, SkeletonRows } from "../../components/ui";
import { toast } from "../../components/toast";
import { openEditor } from "../../data/actions";
import { accountStore, flushAllDirty, queryClient, rpc, useAccountQuery, type RpcError } from "../../data/client";
import { DownloadStaging } from "../assets/DownloadStaging";
import { KnowledgePanel } from "../knowledge/KnowledgePanel";

const refreshJobLists = () => queryClient.invalidateQueries({ queryKey: ["ice", accountStore.get(), "jobs.list"] });

type JobRow = {
  job_id: string; article_id: string; state: string; current_node: string;
  topic: string; final_title: string | null; series: string; episode: number;
  visibility: string; stopping: number | boolean;
};

const STATE_LABEL: Record<string, string> = {
  queued: "排队", running: "制作中", paused: "已暂停", completed: "已完成",
  failed: "失败", cancelled: "已取消", waiting_user: "等待人工审阅",
};

// 状态徽标的语义色：需要用户处理的（失败/等待审阅）一眼可见。
const STATE_TONE: Record<string, string> = {
  running: "info", queued: "info", completed: "success",
  failed: "danger", waiting_user: "warning", paused: "warning",
};

// 与引擎 WORKFLOW_NODES 一一对应；未知节点原样显示，不隐藏信息。
const NODE_LABEL: Record<string, string> = {
  ingest: "接收需求", topic: "选题", research: "调研", outline: "骨架",
  draft: "起草", verify_code: "代码验证", integrate_evidence: "整合运行证据",
  article_review: "文章审阅", style_review: "风格审阅", title_workshop: "标题",
  asset_plan: "配图计划", assets: "配图", final_check: "终检", export: "导出",
};

const ACTIVE_STATES = new Set(["running", "queued"]);
const POLL_ACTIVE_MS = 4_000;
const POLL_IDLE_MS = 20_000;

export function RightPane() {
  const [showArchived, setShowArchived] = React.useState(false);
  // 有任务在跑才快速轮询；全部静止时放慢，减少对本地引擎的无谓读取。
  const jobs = useAccountQuery<JobRow[]>("jobs.list",
    { visibility: showArchived ? "all" : "active" },
    {
      refetchInterval: query =>
        (query.state.data ?? []).some(job => ACTIVE_STATES.has(job.state) || job.stopping)
          ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <KnowledgePanel />
      <DownloadStaging />
      <div style={{ padding: "var(--ice-space-3)", display: "flex", alignItems: "center",
                    gap: "var(--ice-space-2)", borderBottom: "1px solid var(--ice-border)" }}>
        <strong style={{ fontSize: "var(--ice-font-size-md)" }}>制作任务</strong>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: "var(--ice-font-size-sm)", display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={showArchived}
                 onChange={event => setShowArchived(event.target.checked)} />
          含归档
        </label>
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "var(--ice-space-2)" }}>
        {jobs.isLoading && <SkeletonRows rows={3} height={56} gap={8} />}
        {jobs.error && (
          <div role="alert" className="ice-error-text" style={{ padding: 8 }}>
            任务加载失败：{(jobs.error as RpcError).message}
            <button type="button" className="ice-link-btn" style={{ marginLeft: 8 }}
                    onClick={() => jobs.refetch()}>重试</button>
          </div>
        )}
        {!jobs.isLoading && (jobs.data ?? []).length === 0 && (
          <EmptyState title="暂无制作任务" hint="在对话中选择「初稿/改稿」并确认后会在这里出现。" />
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--ice-space-2)",
                     gridTemplateColumns: "minmax(0, 1fr)" }}>
          <AnimatePresence initial={false} mode="popLayout">
            {(jobs.data ?? []).map(job => (
              <motion.li key={job.job_id} layout="position" className="ice-card"
                         initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                         exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                         transition={{ type: "spring", stiffness: 400, damping: 34 }}>
                <JobCard job={job} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
    </div>
  );
}

const DONE_TITLE: Record<string, string> = {
  "jobs.archive": "已归档任务", "jobs.delete": "已移入回收站", "jobs.restore": "已恢复任务", "jobs.resume": "已继续制作",
};

function JobCard({ job }: { job: JobRow }) {
  const stateLabel = STATE_LABEL[job.state] ?? job.state;
  const title = job.final_title || job.topic;
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // R12 批次二：生命周期操作。运行中先 jobs.stop（可靠停止，不假装立即终止）；
  // 归档/删除不级联删除文章/图片/证据（v1.5.3 task_lifecycle 语义）。
  const act = async (method: string, label: string) => {
    if (busy) return;
    setBusy(label); setError(null);
    try {
      await flushAllDirty();
      const stopped = method === "jobs.archive" && job.state === "running" && !job.stopping;
      if (stopped) await rpc("jobs.stop", { job_id: job.job_id });
      await rpc(method, { job_id: job.job_id });
      await refreshJobLists();
      // 被顺带停止的任务撤销后不会自动续跑，给撤销反而误导，只提示结果。
      const undoable = (method === "jobs.archive" || method === "jobs.delete") && !stopped;
      toast.success({
        title: DONE_TITLE[method] ?? "已完成",
        detail: stopped ? "任务已先停止；文章、图片和运行证据都保留" : undefined,
        action: undoable ? {
          label: "撤销",
          run: async () => { await rpc("jobs.restore", { job_id: job.job_id }); await refreshJobLists(); },
        } : undefined,
      });
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(null); }
  };
  const archived = job.visibility && job.visibility !== "active";
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--ice-space-2)" }}>
        <span className={"ice-badge" + (job.stopping ? " ice-badge--warning"
                                         : STATE_TONE[job.state] ? ` ice-badge--${STATE_TONE[job.state]}` : "")}>
          {job.stopping ? "正在停止…" : stateLabel}
        </span>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
          {job.series}-{String(job.episode).padStart(3, "0")}
        </span>
      </div>
      <div style={{ fontWeight: 600, fontSize: "var(--ice-font-size-md)" }}>{title}</div>
      <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
        当前步骤：{NODE_LABEL[job.current_node] ?? job.current_node}
      </div>
      {error && <div role="alert" className="ice-error-text">{error}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {job.state === "completed" && (
          <Button variant="primary" size="sm" onClick={async () => {
            try { await openEditor(job.job_id); }
            catch (error) { setError((error as Error).message); }
          }}>编辑正文</Button>
        )}
        {job.state === "paused" && (
          <Button loading={busy === "续跑"} onClick={() => act("jobs.resume", "续跑")}>续跑</Button>
        )}
        {!archived ? (
          <>
            <RowAction label="归档" busy={busy === "归档"} disabled={Boolean(job.stopping)}
                       title="从列表隐藏，可在「含归档」中恢复；文章、图片和运行证据都保留"
                       onClick={() => act("jobs.archive", "归档")} />
            <RowAction label="删除" busy={busy === "删除"} disabled={Boolean(job.stopping)}
                       title="移入回收站，可恢复；不会删除文章、图片和运行证据"
                       onClick={() => act("jobs.delete", "删除")} />
          </>
        ) : (
          <>
            <RowAction label="恢复" busy={busy === "恢复"}
                       title="恢复为普通任务" onClick={() => act("jobs.restore", "恢复")} />
            <RowAction label="移入回收站" busy={busy === "移入回收站"} disabled={Boolean(job.stopping)}
                       title="移入回收站，可恢复；不会删除文章、图片和运行证据"
                       onClick={() => act("jobs.delete", "移入回收站")} />
          </>
        )}
      </div>
    </>
  );
}

function RowAction({ label, onClick, busy, disabled, title }: {
  label: string; onClick: () => void; busy: boolean; disabled?: boolean; title?: string;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} loading={busy} disabled={disabled} title={title}>
      {label}
    </Button>
  );
}
