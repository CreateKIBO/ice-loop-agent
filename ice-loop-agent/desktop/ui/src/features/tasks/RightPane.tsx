// 右栏（M2-07 行动区基础）：制作任务列表（真实 jobs.list）+ 文章/审阅占位说明。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, EmptyState, SkeletonRows,Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { openEditor } from "../../data/actions";
import { refreshAfterWrite } from "../../data/receipts";
import { accountStore, flushAllDirty, queryClient, rpc, useAccountQuery,useCurrentAccount } from "../../data/client";
import { redactText } from "../../components/errorText";
import { taskStateLabel } from "../../components/display";
import { focusAfterRowRemoval } from "../../components/focusRestore";
import { DownloadStaging } from "../assets/DownloadStaging";
import { KnowledgePanel } from "../knowledge/KnowledgePanel";
import { CopyButton } from "../../components/CopyButton";
import { usePaneActive } from "../../app/PaneActivity";
import { JOB_STATUS_FILTERS, jobGuide, jobMatchesFilter, type JobStatusFilter } from "./jobGuide";
import { loadJobViewPrefs, saveJobViewPrefs, resetJobViewPrefs } from "./jobViewPrefs";

const refreshJobLists = (account = accountStore.get()) => queryClient.invalidateQueries({ queryKey: ["ice", account, "jobs.list"] }, { throwOnError: true });

type JobRow = {
  job_id: string; article_id: string; state: string; current_node: string;
  topic: string; final_title: string | null; series: string; episode: number;
  visibility: string; stopping: number | boolean;
  pause_reason?: string;
};

// 状态徽标的语义色：需要用户处理的（失败/等待审阅）一眼可见。
const STATE_TONE: Record<string, string> = {
  running: "info", queued: "info", completed: "success",
  failed: "danger", waiting_user: "warning", paused: "warning",
  awaiting_approval: "warning", awaiting_user: "warning",
};

const WorkflowReview=React.lazy(()=>import('./WorkflowReview').then(module=>({default:module.WorkflowReview})));

const ACTIVE_STATES = new Set(["running", "queued"]);
const POLL_ACTIVE_MS = 4_000;
const POLL_IDLE_MS = 20_000;

export function RightPane() {
  const active = usePaneActive();
  const [showArchived, setShowArchived] = React.useState(false);
  const [reviewJob,setReviewJob]=React.useState<string|null>(null);
  const account=useCurrentAccount();
  React.useEffect(()=>setReviewJob(null),[account]);
  // 批A3/A4：查找与筛选是列表既有数据上的本地视图；偏好按账号持久化（损坏/存储失败回退默认）。
  const [statusFilter,setStatusFilter]=React.useState<JobStatusFilter>('all');
  const [query,setQuery]=React.useState('');
  const [compact,setCompact]=React.useState(false);
  const [prefsLoadedFor,setPrefsLoadedFor]=React.useState('');
  if(prefsLoadedFor!==account){
    const saved=loadJobViewPrefs(window.localStorage,account);
    setStatusFilter(saved.statusFilter as JobStatusFilter);
    setCompact(saved.compact);
    setPrefsLoadedFor(account);
    setQuery('');setShowArchived(false);
  }
  const persistPrefs=React.useCallback((next:{statusFilter?:JobStatusFilter;compact?:boolean})=>{
    saveJobViewPrefs(window.localStorage,account,{
      statusFilter:next.statusFilter??statusFilter,compact:next.compact??compact});
  },[account,statusFilter,compact]);
  // 批C：恢复本视图默认——白名单仅当前账号的任务查看偏好（筛选/紧凑/搜索词/含归档）。
  const atDefault=statusFilter==='all'&&!compact&&query===''&&!showArchived;
  const [resetNote,setResetNote]=React.useState('');
  const filterRef=React.useRef<HTMLSelectElement>(null);
  React.useEffect(()=>{setResetNote('');},[account]);
  React.useEffect(()=>{
    if(!resetNote)return;
    const timer=window.setTimeout(()=>setResetNote(''),2500);
    return ()=>window.clearTimeout(timer);
  },[resetNote,account]);
  const resetView=()=>{
    setStatusFilter('all');setCompact(false);setQuery('');setShowArchived(false);
    const saved=resetJobViewPrefs(window.localStorage,account);
    setResetNote(saved?'已恢复默认视图':'已在本页恢复默认显示（偏好存储不可用，未永久保存）');
    filterRef.current?.focus({preventScroll:true});
  };
  const review=async(jobId:string)=>{await flushAllDirty();setReviewJob(jobId);};
  // 有任务在跑才快速轮询；全部静止时放慢，减少对本地引擎的无谓读取。
  const jobs = useAccountQuery<JobRow[]>("jobs.list",
    { visibility: showArchived ? "all" : "active" },
    {
      enabled: active,
      refetchInterval: query =>
        (query.state.data ?? []).some(job => ACTIVE_STATES.has(job.state) || job.stopping)
          ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    });
  const allJobs=jobs.data??[];
  const visibleJobs=allJobs.filter(job=>jobMatchesFilter(job,statusFilter,query));
  return (
    <div className="ice-right-islands">
      {/* 资料岛：知识检索与下载暂存；制作任务在下方另一座岛。 */}
      <section className="ice-island ice-island--resources" aria-label="资料">
        <KnowledgePanel />
        <DownloadStaging />
      </section>
      <section className="ice-island ice-island--tasks" aria-label="制作任务">
      <div className="ice-island__head" style={{ padding: "var(--ice-space-3)", display: "flex", alignItems: "center",
                    gap: "var(--ice-space-2)", flexWrap:"wrap", borderBottom: "1px solid var(--ice-border)" }}>
        <strong style={{ fontSize: "var(--ice-font-size-md)" }}>制作任务</strong>
        <input type="search" aria-label="搜索任务标题、栏目或期号" placeholder="搜索标题 / 栏目 / 期号"
               maxLength={60} value={query}
               onChange={event=>setQuery(event.target.value)}
               style={{ flex: "1 1 130px", minWidth: 110, height: 26, borderRadius: 6,
                        border: "1px solid var(--ice-border)", background: "var(--ice-surface)",
                        padding: "0 8px", fontSize: "var(--ice-font-size-sm)" }} />
        <label style={{ fontSize: "var(--ice-font-size-sm)" }}>
          <select ref={filterRef} aria-label="任务状态筛选" value={statusFilter}
                  onChange={event=>{const next=event.target.value as JobStatusFilter;setStatusFilter(next);persistPrefs({statusFilter:next});}}>
            {JOB_STATUS_FILTERS.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label title="紧凑视图：只保留标题、状态与操作" style={{ fontSize: "var(--ice-font-size-sm)", display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" aria-label="任务列表紧凑视图" checked={compact}
                 onChange={event=>{const next=event.target.checked;setCompact(next);persistPrefs({compact:next});}} />
          紧凑
        </label>
        <label style={{ fontSize: "var(--ice-font-size-sm)", display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" aria-label="包含归档任务" checked={showArchived}
                 onChange={event => setShowArchived(event.target.checked)} />
          含归档
        </label>
        <Button size="sm" variant="ghost" disabled={atDefault} title={atDefault?'当前已是默认视图':'恢复状态筛选、紧凑、搜索词与含归档为默认（仅本账号的任务列表显示偏好）'}
                onClick={resetView}>恢复默认视图</Button>
      </div>
      {resetNote&&<div role="status" style={{padding:'0 var(--ice-space-3)',fontSize:'var(--ice-font-size-sm)',color:'var(--ice-text-secondary)'}}>{resetNote}</div>}
      {/* 范围说明：本页统计只针对当前请求返回的数据，不冒充全库统计。 */}
      <div role="status" style={{ padding: "2px var(--ice-space-3)", fontSize: "var(--ice-font-size-sm)",
                                   color: "var(--ice-text-secondary)" }}>
        当前范围：{showArchived ? "全部（含归档）" : "未归档（含已完成）"}任务 · {visibleJobs.length}/{allJobs.length} 项匹配
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "var(--ice-space-2)" }}>
        {jobs.isLoading && <SkeletonRows rows={3} height={56} gap={8} />}
        {jobs.error && (
          <div style={{ padding: 8 }}>
            <ErrorNote error={jobs.error} onRetry={() => jobs.refetch()} retryLabel="重新加载任务" />
          </div>
        )}
        {!jobs.isLoading && !jobs.error && allJobs.length === 0 && (
          <EmptyState title={showArchived ? "没有归档任务" : "暂无制作任务"}
                      hint={showArchived
                        ? "归档只是从默认列表隐藏；取消勾选「含归档」查看进行中的任务。"
                        : "在对话中选择「初稿/改稿」并确认后会在这里出现。"} />
        )}
        {!jobs.isLoading && !jobs.error && allJobs.length > 0 && visibleJobs.length === 0 && (
          <EmptyState title="没有匹配的任务"
                      hint={`当前筛选（{${JOB_STATUS_FILTERS.find(f=>f.value===statusFilter)?.label}}${query.trim()?` · “${query.trim()}”`:''}）下没有任务。`}
                      action={<Button size="sm" onClick={()=>{setStatusFilter('all');setQuery('');persistPrefs({statusFilter:'all'});}}>清除筛选条件</Button>} />
        )}
        <ul tabIndex={-1} aria-label="制作任务列表" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--ice-space-2)",
                     gridTemplateColumns: "minmax(0, 1fr)" }}>
          <AnimatePresence initial={false} mode="popLayout">
            {visibleJobs.map(job => (
              <motion.li key={job.job_id} data-job-id={job.job_id} layout="position" className="ice-card"
                         initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                         exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                         transition={{ type: "spring", stiffness: 400, damping: 34 }}>
                <JobCard job={job} compact={compact} onReview={review} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
      {reviewJob&&<React.Suspense fallback={<div role="status" style={{padding:12}}><Spinner size={14} />正在打开任务…</div>}>
        <WorkflowReview key={account+':'+reviewJob} jobId={reviewJob} onClose={()=>setReviewJob(null)} />
      </React.Suspense>}
      </section>
    </div>
  );
}

const DONE_TITLE: Record<string, string> = {
  "jobs.archive": "已归档任务", "jobs.delete": "已移入回收站", "jobs.restore": "已恢复任务", "jobs.resume": "已继续制作",
};

function JobCard({ job, compact, onReview }: { job: JobRow; compact: boolean; onReview:(jobId:string)=>Promise<void> }) {
  const account = useCurrentAccount();
  const guide = jobGuide(job);
  const stateLabel = taskStateLabel(job.state);
  const title = job.final_title || job.topic;
  const [busy, setBusy] = React.useState<string | null>(null);
  const busyRef = React.useRef(false); // 2026-10-20：同 tick 连点绕过 state 闭包，ref 双闸
  const [opening, setOpening] = React.useState<"review" | "editor" | null>(null);
  const openingRef = React.useRef<"review" | "editor" | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  // R12 批次二：生命周期操作。运行中先 jobs.stop（可靠停止，不假装立即终止）；
  // 归档/删除不级联删除文章/图片/证据（v1.5.3 task_lifecycle 语义）。
  const act = async (method: string, label: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label); setError(null);
    try {
      await flushAllDirty();
      if (accountStore.get() !== account) throw Error("公众号已切换，请在原公众号操作");
      const stopped = method === "jobs.archive" && job.state === "running" && !job.stopping;
      if (stopped) await rpc("jobs.stop", { job_id: job.job_id, account_id: account });
      await rpc(method, { job_id: job.job_id, account_id: account });
      focusAfterRowRemoval(cardRef.current, "[data-job-focus]");
      // 被顺带停止的任务撤销后不会自动续跑，给撤销反而误导，只提示结果。
      const undoable = (method === "jobs.archive" || method === "jobs.delete") && !stopped;
      toast.success({
        title: DONE_TITLE[method] ?? "已完成",
        detail: stopped ? "任务已先停止；文章、图片和运行证据都保留" : undefined,
        action: undoable ? {
          label: "撤销",
          run: async () => {
            if (accountStore.get() !== account) throw Error("请先切回原公众号再撤销");
            await flushAllDirty();
            if (accountStore.get() !== account) throw Error("公众号已切换，已取消撤销");
            await rpc("jobs.restore", { job_id: job.job_id, account_id: account });
            await refreshAfterWrite("撤销", () => refreshJobLists(account));
          },
        } : undefined,
      });
      // 任务卡可能因列表过滤（默认不含归档）被移除；写已成功，刷新失败单独提示。
      await refreshAfterWrite(DONE_TITLE[method] ?? "任务操作", () => refreshJobLists(account));
    } catch (err) { setError(err); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const openWith = async (kind: "review" | "editor") => {
    if (openingRef.current) return;
    openingRef.current = kind;
    setOpening(kind); setError(null);
    try {
      if (kind === "review") await onReview(job.job_id);
      else await openEditor(job.job_id);
    } catch (err) { setError(err); }
    finally { openingRef.current = null; setOpening(null); }
  };
  const archived = job.visibility && job.visibility !== "active";
  return (
    <>
      <div ref={cardRef} data-job-focus tabIndex={-1} style={{ display: "flex", alignItems: "center", gap: "var(--ice-space-2)", outline: "none" }}>
        <span className={"ice-badge" + (job.stopping ? " ice-badge--warning"
                                         : STATE_TONE[job.state] ? ` ice-badge--${STATE_TONE[job.state]}` : "")}>
          {job.stopping ? "正在停止…" : stateLabel}
        </span>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
          {job.series}-{String(job.episode).padStart(3, "0")}
        </span>
      </div>
      <div style={{ fontWeight: 600, fontSize: "var(--ice-font-size-md)" }}>{title}</div>
      {/* 批A1/A2：本篇制作总览（状态 · 当前步骤 · 阻塞摘要）+ 确定性“建议下一步”；
          动作全部映射到下方既有按钮。 */}
      {!compact && (
        <div style={{ fontSize: "var(--ice-font-size-sm)", display: "grid", gap: 2 }}>
          <span style={{ color: "var(--ice-text-secondary)" }}>
            {guide.summary}{guide.blocking ? ` · ${guide.blocking}` : ""}
          </span>
          <span>建议下一步：<strong style={{ color: "var(--ice-text)" }}>{guide.actions[0]?.label}</strong>
            <span style={{ color: "var(--ice-text-secondary)" }}>（{guide.actions[0]?.hint}）</span></span>
        </div>
      )}
      {job.pause_reason && ['paused','failed','awaiting_user'].includes(job.state) && !compact && (
        <details style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
          <summary style={{ cursor: "pointer" }}>{job.state === 'failed' ? '查看中断原因' : '查看需要处理的内容'}</summary>
          <p style={{ margin: "6px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{redactText(job.pause_reason)}</p>
          <CopyButton text={redactText(job.pause_reason)} label="复制原因" />
        </details>
      )}
      {error != null && <ErrorNote error={error} note="操作未生效，任务保持原状态。" />}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {!archived&&['awaiting_approval','awaiting_user','failed','running','queued','paused'].includes(job.state)&&
          <Button size="sm" variant={job.state==='awaiting_approval'||job.state==='awaiting_user'?'primary':'secondary'}
            loading={opening === "review"}
            onClick={()=>void openWith("review")}>
            {job.state==='awaiting_approval'?'审阅此步':job.current_node==='verify_code'&&job.state!=='running'?'审阅代码与输入':'查看处理进度'}
          </Button>}
        {job.state === "completed" && (
          <Button variant="primary" size="sm" loading={opening === "editor"}
                  onClick={() => void openWith("editor")}>编辑正文</Button>
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
