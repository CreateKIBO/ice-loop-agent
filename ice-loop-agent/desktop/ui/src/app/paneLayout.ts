// 三栏宽度计算（纯函数，无 DOM 依赖，便于单测）。
//
// 两套尺寸：
//   preferred —— 用户拖出来的"想要的宽度"，会被持久化；
//   sizes     —— 按当前窗口宽度夹紧后的"实际宽度"，保证中栏不被挤没。
// 窗口临时缩小只影响 sizes，不会把用户保存的布局永久缩小。

export interface PaneSizes { left: number; right: number }
export interface PaneVisibility { left: boolean; right: boolean }
export type CompactPane = "left" | "center" | "right";
export const COMPACT_WIDTH = 1080;

export function normalizeVisibility(raw: Partial<PaneVisibility> | null): PaneVisibility {
  return { left: typeof raw?.left === "boolean" ? raw.left : true,
           right: typeof raw?.right === "boolean" ? raw.right : true };
}

/** Compact windows show one full-width surface; narrowing never overwrites dock preferences. */
export function resolveLayout(preferred: PaneSizes, width: number, docked: PaneVisibility, selected: CompactPane) {
  const compact = width > 0 && width < COMPACT_WIDTH;
  if (compact) return { compact, left: selected === "left", right: selected === "right",
    center: selected === "center", sizes: { left: width, right: width } };
  const sizes = fitSizes(preferred, width);
  const normalized = normalizeSizes(preferred);
  if (!docked.right) sizes.left = Math.min(normalized.left, Math.max(MIN_LEFT, width - 5 - COMFORT_CENTER));
  if (!docked.left) sizes.right = Math.min(normalized.right, Math.max(MIN_RIGHT, width - 5 - COMFORT_CENTER));
  return { compact, left: docked.left, right: docked.right, center: true, sizes };
}

export function resizeVisiblePane(previous: PaneSizes, side: "left" | "right", delta: number,
                                  width: number, docked: PaneVisibility): PaneSizes {
  if (docked.left && docked.right) return resizePane(previous, side, delta, width);
  const current = resolveLayout(previous, width, docked, "center").sizes;
  const room = width - 5 - COMFORT_CENTER;
  return side === "left"
    ? { ...previous, left: clamp(current.left + delta, MIN_LEFT, Math.min(MAX_LEFT, Math.max(MIN_LEFT, room))) }
    : { ...previous, right: clamp(current.right - delta, MIN_RIGHT, Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, room))) };
}

export const PANE_DEFAULTS: PaneSizes = { left: 260, right: 380 };
export const MIN_LEFT = 200, MIN_RIGHT = 280;
export const MAX_LEFT = 480, MAX_RIGHT = 640;
// 窗口很窄时允许压到的硬下限，再窄就只能横向裁切。
const HARD_MIN_LEFT = 160, HARD_MIN_RIGHT = 220;
const MIN_CENTER = 320;
// 中栏是写作区：中等宽度窗口里先让侧栏让到常规下限，尽量保住这个宽度。
const COMFORT_CENTER = 480;
const DIVIDER_TOTAL = 10; // 两条分隔条各 5px

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function normalizeSizes(raw: Partial<PaneSizes>): PaneSizes {
  return {
    left: clamp(Number(raw.left) || PANE_DEFAULTS.left, MIN_LEFT, MAX_LEFT),
    right: clamp(Number(raw.right) || PANE_DEFAULTS.right, MIN_RIGHT, MAX_RIGHT),
  };
}

/**
 * 按容器宽度夹紧，分两段：先让中栏达到舒适宽度（侧栏只压到常规下限），
 * 仍放不下再保中栏最小宽度（侧栏压到硬下限）。每段都先压右栏再压左栏。
 * width<=0 表示尚未测量。
 */
export function fitSizes(preferred: PaneSizes, width: number): PaneSizes {
  let { left, right } = normalizeSizes(preferred);
  if (width <= 0) return { left, right };
  const squeeze = (center: number, floorLeft: number, floorRight: number) => {
    let overflow = left + right - (width - DIVIDER_TOTAL - center);
    if (overflow <= 0) return;
    const fromRight = Math.max(0, Math.min(overflow, right - floorRight));
    right -= fromRight;
    overflow -= fromRight;
    if (overflow > 0) left -= Math.max(0, Math.min(overflow, left - floorLeft));
  };
  squeeze(COMFORT_CENTER, MIN_LEFT, MIN_RIGHT);
  squeeze(MIN_CENTER, HARD_MIN_LEFT, HARD_MIN_RIGHT);
  return { left, right };
}

/**
 * 拖动分隔条后的新偏好。以"实际宽度"为基准，避免窗口被压缩时拖动跳变；
 * 上限按舒适中栏计算，与 fitSizes 一致，不会出现"偏好变了但界面不动"。
 * 另一侧保留用户原来的偏好值，不把被临时压缩的宽度写回去。
 */
export function resizePane(previous: PaneSizes, side: "left" | "right", deltaPx: number, width: number): PaneSizes {
  const current = fitSizes(previous, width);
  const total = width - DIVIDER_TOTAL - COMFORT_CENTER;
  const bounded = (value: number, low: number, high: number) => clamp(value, low, Math.max(low, high));
  if (side === "left") {
    const room = width > 0 ? total - current.right : MAX_LEFT;
    return { ...previous, left: bounded(current.left + deltaPx, MIN_LEFT, Math.min(MAX_LEFT, room)) };
  }
  const room = width > 0 ? total - current.left : MAX_RIGHT;
  return { ...previous, right: bounded(current.right - deltaPx, MIN_RIGHT, Math.min(MAX_RIGHT, room)) };
}
