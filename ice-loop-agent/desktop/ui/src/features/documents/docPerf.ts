// v3.12 编辑器性能读数（开发报告 §9：首次可编辑、输入响应、保存、峰值内存）。
// 只在内存里记录当前会话的数字，不上传、不写盘；“性能样本”文章的侧栏显示，也可在开发者工具里读 window.__iceDocPerf。
export type PerfSnapshot = {
  documentId: string | null;
  openMs: number | null;        // 打开请求 → 内容到达
  editableMs: number | null;    // 打开请求 → 编辑器可输入
  input: { count: number; p50: number | null; p95: number | null; max: number | null };
  saves: { count: number; p50: number | null; max: number | null; last: number | null };
  heapMb: number | null;        // Chromium 的 performance.memory（JS 堆，非整进程）
  heapPeakMb: number | null;
};

const LIMIT = 500;
let documentId: string | null = null;
let openedAt = 0;
let openMs: number | null = null;
let editableMs: number | null = null;
let inputs: number[] = [];
let saves: number[] = [];
let heapPeak = 0;
const listeners = new Set<() => void>();

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const pct = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};
function heap(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (!memory) return null;
  const mb = Math.round(memory.usedJSHeapSize / 1024 / 1024 * 10) / 10;
  heapPeak = Math.max(heapPeak, mb);
  return mb;
}
function emit() { for (const listener of listeners) listener(); }
const push = (list: number[], value: number) => { list.push(value); if (list.length > LIMIT) list.shift(); };

export const docPerf = {
  open(id: string) {
    documentId = id; openedAt = now(); openMs = null; editableMs = null; inputs = []; saves = []; heapPeak = 0; heap(); emit();
  },
  loaded(id: string) { if (id === documentId && openMs === null) { openMs = Math.round(now() - openedAt); emit(); } },
  editable(id: string) { if (id === documentId && editableMs === null) { editableMs = Math.round(now() - openedAt); heap(); emit(); } },
  /** 按键到下一帧绘制的近似输入响应。 */
  keystroke(id: string) {
    if (id !== documentId) return;
    const start = now();
    requestAnimationFrame(() => requestAnimationFrame(() => { push(inputs, now() - start); if (inputs.length % 10 === 0) { heap(); emit(); } }));
  },
  saved(id: string, ms: number) { if (id === documentId) { push(saves, ms); heap(); emit(); } },
  snapshot(): PerfSnapshot {
    return {
      documentId, openMs, editableMs,
      input: { count: inputs.length, p50: pct(inputs, 50), p95: pct(inputs, 95), max: inputs.length ? Math.round(Math.max(...inputs) * 10) / 10 : null },
      saves: { count: saves.length, p50: pct(saves, 50), max: saves.length ? Math.round(Math.max(...saves)) : null,
               last: saves.length ? Math.round(saves[saves.length - 1]) : null },
      heapMb: heap(), heapPeakMb: heapPeak || null,
    };
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

if (typeof window !== "undefined") (window as unknown as { __iceDocPerf?: typeof docPerf }).__iceDocPerf = docPerf;
