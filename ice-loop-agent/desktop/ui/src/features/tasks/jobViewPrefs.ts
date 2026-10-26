// 批A4（2026-10-22）：任务列表查看偏好的轻量持久化。
// 只保存筛选与紧凑开关，带版本与账号范围；损坏/超限时回退默认。
// 明确不保存：搜索词、正文、Key、API 响应、浏览器 cookies。
const VERSION = 1;
const KEY = (account: string) => `ice.ui.jobview.v${VERSION}.${account}`;
const MAX_LENGTH = 256;

export type JobViewPrefs = { statusFilter: string; compact: boolean };

export const DEFAULT_JOB_VIEW: JobViewPrefs = { statusFilter: "all", compact: false };
const ALLOWED_FILTERS = new Set(["all", "mine", "running", "paused", "failed", "completed"]);

function parse(raw: string | null): JobViewPrefs {
  if (!raw || raw.length > MAX_LENGTH) return DEFAULT_JOB_VIEW;
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_JOB_VIEW;
    return {
      statusFilter: typeof value.statusFilter === "string" && ALLOWED_FILTERS.has(value.statusFilter)
        ? value.statusFilter : DEFAULT_JOB_VIEW.statusFilter,
      compact: value.compact === true,
    };
  } catch {
    return DEFAULT_JOB_VIEW; // 损坏的偏好不影响列表可用性
  }
}

export function loadJobViewPrefs(storage: Pick<Storage, "getItem">, account: string): JobViewPrefs {
  try { return parse(storage.getItem(KEY(account))); } catch { return DEFAULT_JOB_VIEW; }
}

export function saveJobViewPrefs(storage: Pick<Storage, "setItem" | "removeItem">,
                                 account: string, prefs: JobViewPrefs): boolean {
  const payload = JSON.stringify({ statusFilter: prefs.statusFilter, compact: prefs.compact });
  if (payload.length > MAX_LENGTH) return false; // 结构异常时拒绝写入而不是抛错
  try { storage.setItem(KEY(account), payload); return true; }
  catch { return false; } // 存储不可用（隐私模式/配额）时静默降级为会话内状态
}

export function clearJobViewPrefs(storage: Pick<Storage, "removeItem">, account: string): void {
  // 只清除本账号的查看偏好键，不触碰其他数据。
  try { storage.removeItem(KEY(account)); } catch { /* 同上 */ }
}

/** 批C（2026-10-25）：恢复默认=写回 DEFAULT_JOB_VIEW 并移除该账号偏好键（白名单，单一键）。
 *  存储不可用时返回 false——界面可退化为临时默认显示，但不声称已永久保存。 */
export function resetJobViewPrefs(storage: Pick<Storage, "setItem" | "removeItem">, account: string): boolean {
  try { storage.removeItem(KEY(account)); return saveJobViewPrefs(storage, account, DEFAULT_JOB_VIEW); }
  catch { return false; }
}
