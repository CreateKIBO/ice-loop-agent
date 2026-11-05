// 第29轮：跨区域"结果落在这里"的轻闪反馈。只改背景色、不位移、不改 DOM；
// 系统或程序内减弱动效时直接跳过（与 useActivityReducedMotion 读取同两条通道）。
export type FlashTone = "--ice-info-bg" | "--ice-success-bg" | "--ice-danger-bg";

export function motionReduced(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    || document.documentElement.dataset.reduceMotion === "true";
}

export function flashSurface(element: Element | null | undefined, tone: FlashTone = "--ice-info-bg", duration = 1100): void {
  const node = element as HTMLElement | null | undefined;
  if (!node?.animate || motionReduced()) return;
  node.animate([{ backgroundColor: `var(${tone})` }, { backgroundColor: `var(${tone})`, offset: 0.25 }, {}],
    { duration, easing: "ease-out" });
}
