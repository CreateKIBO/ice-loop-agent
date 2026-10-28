// 全局轻提示：操作结果反馈 + 可撤销动作（如"已移入回收站 · 撤销"）。
// 悬停或键盘聚焦时暂停倒计时，读完再走；危险提示用 role=alert 立即播报。
import * as React from "react";
import { useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from 'react-dom';
import { toastHost } from './toastHost';
import { errorDisplay, redactText } from './errorText';
import { useActivityReducedMotion, useDocumentVisible } from './ActivityRail';
import { ToastLifetime } from './toastLifetime';

type Tone = "info" | "success" | "warning" | "danger";
type ToastAction = { label: string; run: () => unknown };
type ToastInput = { title: string; detail?: string; action?: ToastAction; duration?: number };
type ToastItem = ToastInput & { id: number; tone: Tone; duration: number; running?: boolean; lifetime: ToastLifetime };

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
  items = [...items, { ...value, id, tone, duration, lifetime: new ToastLifetime(duration) }].slice(-MAX_VISIBLE);
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

// The action belongs to the notification, not a card instance: moving the
// portal into/out of a modal remounts cards and must not reset an in-flight lock.
async function runAction(id: number) {
  const item = items.find(current => current.id === id);
  if (!item?.action || item.running) return;
  items = items.map(current => current.id === id ? { ...current, running: true } : current);
  emit(); // Synchronous store lock also blocks same-tick replays before render.
  try { await item.action.run(); toast.dismiss(id); }
  catch (error) {
    toast.dismiss(id);
    const feedback = errorDisplay(error);
    toast.error({ title: item.action.label + "失败", detail: [feedback.title, feedback.detail].filter(Boolean).join('：') });
  }
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => items;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot);
  const host = useSyncExternalStore(toastHost.subscribe, toastHost.get);
  const ref = React.useRef<HTMLDivElement>(null), [scrollable, setScrollable] = React.useState(false);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setScrollable(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [list, host]);
  const content = (
    <div ref={ref} className={'ice-toaster' + (host ? ' ice-toaster--modal' : '')} role="region" aria-label="通知"
      tabIndex={scrollable ? 0 : undefined} data-scrollable={scrollable}>
      <AnimatePresence initial={false}>
        {list.map(item => <ToastCard key={item.id} item={item} />)}
      </AnimatePresence>
    </div>
  );
  return host ? createPortal(content, host) : content;
}

const ICON: Record<Tone, string> = { info: "i", success: "✓", warning: "!", danger: "×" };

function ToastDetail({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null), [scrollable, setScrollable] = React.useState(false);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setScrollable(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return <div ref={ref} className="ice-toast__detail" tabIndex={scrollable ? 0 : undefined}
    role={scrollable ? 'region' : undefined} aria-label={scrollable ? '通知详情' : undefined}>{text}</div>;
}

function ToastCard({ item }: { item: ToastItem }) {
  const ref = React.useRef<HTMLDivElement>(null), [inView, setInView] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const running = Boolean(item.running);
  const visible = useDocumentVisible(), reduced = useActivityReducedMotion();
  // Count reading time only while at least half of the card is geometrically
  // visible. IntersectionObserver also accounts for scroll-container clipping.
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting && entry.intersectionRatio >= 0.5);
    }, { threshold: 0.5 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const paused = hovered || focused || running || !visible || !inView;
  const lifetime = item.lifetime;
  // Keep the CSS phase across ordinary renders; align it on a portal remount
  // or when motion resumes after a preference/visibility change.
  const progressDelay = React.useMemo(() => -(item.duration - lifetime.remaining()), [lifetime, item.duration, reduced, inView]);

  React.useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => toast.dismiss(item.id), lifetime.resume());
    return () => {
      window.clearTimeout(timer);
      lifetime.pause();
    };
  }, [paused, item.id, lifetime]);

  return (
    <motion.div
      ref={ref}
      initial={reduced || !visible ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced || !visible ? 0 : 0.16 }}
      className={`ice-toast ice-toast--${item.tone}`}
      role={item.tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    >
      <span className="ice-toast__icon" aria-hidden>{ICON[item.tone]}</span>
      <div className="ice-toast__body">
        <div className="ice-toast__title">{item.title}</div>
        {item.detail && <ToastDetail text={item.detail} />}
      </div>
      {item.action && (
        <button type="button" className="ice-toast__action" onClick={() => void runAction(item.id)} disabled={running} aria-busy={running || undefined}>
          {running ? "处理中…" : item.action.label}
        </button>
      )}
      <button type="button" className="ice-toast__close" aria-label="关闭通知" onClick={() => toast.dismiss(item.id)}>×</button>
      <span className="ice-toast__progress" aria-hidden
            style={{ animationDuration: item.duration + "ms", animationDelay: progressDelay + 'ms', animationPlayState: paused ? "paused" : "running",
              ...(reduced || !inView ? { animationName: 'none' } : {}) }} />
    </motion.div>
  );
}
