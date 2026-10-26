// 批A（2026-10-22 用户制作流程）：任务总览与“建议下一步”的纯推导。
// 只读现有 jobs.list 字段做确定性展示，不发起任何模型/执行请求；
// 动作映射到任务卡既有的三个真实入口（review / resume / editor）。
import { redactText } from "../../components/errorText";
import { NODE_LABEL } from "./taskTypes";
import { taskStateLabel } from "../../components/display";

export type GuideJob = {
  state: string; current_node: string; stopping?: number | boolean;
  pause_reason?: string; visibility?: string;
};

export type GuideAction = {
  key: "review" | "resume" | "editor";
  label: string; hint: string; primary: boolean;
};

export type JobGuide = {
  /** 徽章语义色：等待用户处理最醒目。 */
  tone: "danger" | "warning" | "info" | "success" | "";
  /** 一句话总览：状态 · 当前步骤 · 阻塞原因（若有且简短）。 */
  summary: string;
  /** 当前阻塞用户的真实原因（来自任务字段，不编造）；无则为 null。 */
  blocking: string | null;
  /** 按优先级排序的建议动作；全部对应既有入口。 */
  actions: GuideAction[];
  /** 是否属于“需要我处理”（等待审批/输入/失败/暂停恢复）。 */
  needsUser: boolean;
};

/** 建议下一步：确定性优先级，输入只有 jobs.list 的既有字段。 */
export function jobGuide(job: GuideJob): JobGuide {
  const node = Object.hasOwn(NODE_LABEL,job.current_node) ? NODE_LABEL[job.current_node] : job.current_node;
  const stateLabel = taskStateLabel(job.state);
  const reason = job.pause_reason ? redactText(job.pause_reason).trim() || null : null;
  const shortReason = reason && reason.length > 60 ? reason.slice(0, 60) + "…" : reason;
  const guide: JobGuide = {
    tone: job.state === "failed" ? "danger"
      : ["awaiting_approval", "awaiting_user", "paused"].includes(job.state) ? "warning"
      : ["running", "queued"].includes(job.state) ? "info"
      : job.state === "completed" ? "success" : "",
    summary: `状态 ${stateLabel} · 当前步骤 ${node}`,
    blocking: shortReason,
    actions: [],
    needsUser: ["awaiting_approval", "awaiting_user", "failed", "paused"].includes(job.state),
  };
  const review = (label: string, primary: boolean, hint: string): GuideAction =>
    ({ key: "review", label, hint, primary });
  if (job.stopping) {
    guide.summary = `状态 正在停止 · 当前步骤 ${node}`;
    guide.actions = [review("查看处理进度", true, "任务正在停止当前程序，停止完成后可继续处理")];
    return guide;
  }
  switch (job.state) {
    case "awaiting_approval":
    case "awaiting_user":
      guide.actions = [
        review(job.state === "awaiting_approval" ? "审阅此步"
             : job.current_node === "verify_code" ? "审阅代码与输入" : "查看需要处理的内容", true,
             "打开任务审阅，确认当前方案或补充需要的内容"),
        review("查看处理进度", false, "只读查看当前步骤与说明"),
      ];
      break;
    case "failed":
      guide.actions = [review("查看中断原因", true, "打开任务查看中断原因，处理后可从这里继续")];
      break;
    case "paused":
      guide.actions = [
        { key: "resume", label: "继续制作", hint: "显式续跑暂停任务，遇到需要审阅的步骤会再次等待", primary: true },
        review("查看处理进度", false, "查看暂停原因与当前步骤"),
      ];
      break;
    case "running":
    case "queued":
      guide.actions = [review("查看处理进度", true, "任务进行中；需要你处理时会出现在这里")];
      break;
    case "completed":
      guide.actions = [
        { key: "editor", label: "编辑正文", hint: "打开正文编辑与交付审阅，准备配图并导出", primary: true },
        review("查看处理进度", false, "回看制作过程与结果"),
      ];
      break;
    default:
      // 未知状态保留原始含义，不给可能错误的建议。
      guide.actions = [review("查看详情", true, `未识别的任务状态：${job.state}`)];
  }
  return guide;
}

/** A3“需要我处理”视图的稳定口径：等待审批/输入、失败待处理、暂停待恢复。 */
export const needsUserAction = (job: GuideJob) =>
  ["awaiting_approval", "awaiting_user", "failed", "paused"].includes(job.state) && !job.stopping;

/** A3 状态筛选口径（与任务状态字段一一对应，不引入新状态）。 */
export type JobStatusFilter = "all" | "mine" | "running" | "paused" | "failed" | "completed";

export const JOB_STATUS_FILTERS: Array<{ value: JobStatusFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "mine", label: "需要我处理" },
  { value: "running", label: "进行中" },
  { value: "paused", label: "已暂停" },
  { value: "failed", label: "已中断" },
  { value: "completed", label: "已完成" },
];

export function jobMatchesFilter(job: GuideJob & { topic?: string; final_title?: string | null; series?: string; episode?: number },
                                 filter: JobStatusFilter, query: string): boolean {
  if (filter === "mine" && !needsUserAction(job)) return false;
  if (filter === "running" ? !["running","queued"].includes(job.state) : filter !== "all" && filter !== "mine" && job.state !== filter) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const title = (job.final_title || job.topic || "").toLowerCase();
  const series = (job.series || "").toLowerCase();
  const episode = String(job.episode ?? "");
  return title.includes(needle) || series.includes(needle)
    || episode === needle || `${series}-${episode}` === needle || `${series}${episode}`.includes(needle);
}
