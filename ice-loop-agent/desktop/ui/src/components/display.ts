// 类型化显示工具（批次1-06）：时间/时长/字节数/任务状态标签的单一来源。
// 内部状态仍用原枚举字符串；这里的中文翻译只用于展示，不参与业务判断。
// 未知枚举必须有可见兜底（原值直显），不能静默当成功。

/** 毫秒 → 人读时长。未知(null/undefined/NaN)返回 "—"。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m${rest ? ` ${rest}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 字节数 → 人读大小（1024 进）。未知返回 "—"。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** ISO 时间 → 本地短时间（当天只显示时分；跨天补月日）。无效返回原串兜底。 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return hm;
  return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}

/** 队列/引擎任务状态 → 中文标签。未知状态直显原值（可见兜底）。 */
export function taskStateLabel(state: string | null | undefined): string {
  if (!state) return "未知状态";
  return Object.hasOwn(TASK_STATE_LABELS, state) ? TASK_STATE_LABELS[state] : state;
}

const TASK_STATE_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  awaiting_approval: "等待审批",
  awaiting_user: "需要你的处理",
  succeeded: "已完成",
  waiting_user: "等待人工处理",
  waiting_model: "等待模型",
  waiting_resource: "等待资源",
  interrupted: "被中断",
};

/** 保存/同步回执状态 → 中文标签（批次3-19 也复用）。 */
export function saveStateLabel(state: string): string {
  return Object.hasOwn(SAVE_STATE_LABELS, state) ? SAVE_STATE_LABELS[state] : state;
}

const SAVE_STATE_LABELS: Record<string, string> = {
  dirty: "未保存",
  saving: "保存中",
  saved: "已保存",
  error: "保存失败",
  conflict: "版本冲突",
};

/** 数量 + 名词的中文复数兜底（0/1/N 均合法）。 */
export function formatCount(count: number, noun: string): string {
  return `${count} ${noun}`;
}
