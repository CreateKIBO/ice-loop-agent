// Observe the actual removal: a slow refresh must not exhaust a fixed delay.
export const ROW_EXIT_WAIT_MS = 320;
export function pickFocusTarget<T>(rows: T[], removedIndex: number, list: T | null): T | null {
  if (removedIndex >= 0 && removedIndex < rows.length) return rows[removedIndex];
  if (removedIndex > 0 && removedIndex - 1 < rows.length) return rows[removedIndex - 1];
  return list;
}

export function focusAfterRowRemoval(row: HTMLElement | null, rowSelector: string): () => void {
  if (!row) return () => {};
  const list = row.closest("ul,ol");
  const origin = row.closest("li") ?? row;
  const active = document.activeElement;
  // The action may have been invoked by pointer; never steal another panel's focus.
  if (!list || (active !== document.body && !origin.contains(active))) return () => {};
  const originalRows = Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
  const index = originalRows.findIndex(node => row.contains(node));
  if (index < 0) return () => {};
  let settle: number | undefined;
  const stop = () => { observer.disconnect(); window.clearTimeout(deadline); window.clearTimeout(settle); };
  const restore = () => {
    stop();
    if (!list.isConnected || row.isConnected) return;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== active) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
    const next = pickFocusTarget(rows, index, list as HTMLElement);
    if (next) {
      if (!next.hasAttribute("tabindex") && next === list) next.tabIndex = -1;
      next.focus();
    }
  };
  const observe = () => {
    if (!list.isConnected) { stop(); return; }
    if (!row.isConnected && settle === undefined) settle = window.setTimeout(restore, ROW_EXIT_WAIT_MS);
  };
  const observer = new MutationObserver(observe);
  const deadline = window.setTimeout(stop, 10_000);
  observer.observe(document.body, { childList: true, subtree: true });
  observe();
  return stop;
}
