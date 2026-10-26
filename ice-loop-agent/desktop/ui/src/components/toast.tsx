// 全局轻提示：操作结果反馈 + 可撤销动作（如"已移入回收站 · 撤销"）。
// 悬停或键盘聚焦时暂停倒计时，读完再走；危险提示用 role=alert 立即播报。
import * as React from "react";
import { useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from 'react-dom';
import { toastHost } from './toastHost';
import { redactText } from './errorText';

type Tone = "info" | "success" | "warning" | "danger";
type ToastAction = { label: string; run: () => unknown };
type ToastInput = { title: string; detail?: string; action?: ToastAction; duration?: number };
type ToastItem = ToastInput & { id: number; tone: Tone; duration: number };

const MAX_VISIBLE = 4;
const DEFAULT_DURATION: Record<Tone, number> = { info: 3_500, success: 3_500, warning: 6_000, danger: 7_000 };

let items: ToastItem[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

function show(tone: Tone, input: ToastInput | string): number {
  const raw = typeof input === "string" ? { title: input } : input;
  const value = { ...raw, title: redactText(raw.title), detail: raw.detail ? redactText(raw.detail) : undefined };
  const id = ++sequence;
  // 带动作的提示多给几秒，避免"撤销"还没点到就消失。
  const duration = value.duration ?? DEFAULT_DURATION[tone] + (value.action ? 2_500 : 0);
  items = [...items, { ...value, id, tone, duration }].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export const toast = {
  info: (input: ToastInput | string) => show("info", input),
  success: (input: ToastInput | string) => show("success", input),
  warning: (input: ToastInput | string) => show("warning", input),
  error: (input: ToastInput | string) => show("danger", input),
  dismiss(id: number) {
    if (!items.some(item => item.id === id)) return;
    items = items.filter(item => item.id !== id);
    emit();
  },
};

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => items;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot);
  const host = useSyncExternalStore(toastHost.subscribe, toastHost.get);
  const content = (
    <div className={'ice-toaster' + (host ? ' ice-toaster--modal' : '')} role="region" aria-label="通知">
      <AnimatePresence initial={false}>
        {list.map(item => <ToastCard key={item.id} item={item} />)}
      </AnimatePresence>
    </div>
  );
  return host ? createPortal(content, host) : content;
}

const ICON: Record<Tone, string> = { info: "i", success: "✓", warning: "!", danger: "×" };

function ToastCard({ item }: { item: ToastItem }) {
  const [paused, setPaused] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false); // Block same-tick action replay before React commits disabled.
  const remaining = React.useRef(item.duration);
  const startedAt = React.useRef(0);

  React.useEffect(() => {
    if (paused || running) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => toast.dismiss(item.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, running, item.id]);

  const runAction = async () => {
    if (!item.action || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try { await item.action.run(); toast.dismiss(item.id); }
    catch (error) {
      toast.dismiss(item.id);
      toast.error({ title: item.action.label + "失败", detail: (error as Error).message });
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 32, transition: { duration: 0.16 } }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={`ice-toast ice-toast--${item.tone}`}
      role={item.tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    >
      <span className="ice-toast__icon" aria-hidden>{ICON[item.tone]}</span>
      <div className="ice-toast__body">
        <div className="ice-toast__title">{item.title}</div>
        {item.detail && <div className="ice-toast__detail">{item.detail}</div>}
      </div>
      {item.action && (
        <button type="button" className="ice-toast__action" onClick={runAction} disabled={running}>
          {running ? "处理中…" : item.action.label}
        </button>
      )}
      <button type="button" className="ice-toast__close" aria-label="关闭通知" onClick={() => toast.dismiss(item.id)}>×</button>
      <span className="ice-toast__progress" aria-hidden
            style={{ animationDuration: item.duration + "ms", animationPlayState: paused ? "paused" : "running" }} />
    </motion.div>
  );
}
