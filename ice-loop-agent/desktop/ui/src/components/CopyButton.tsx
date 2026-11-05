import * as React from "react";
import { Button } from "./ui";
import { toast } from "./toast";
import { errorDisplay } from "./errorText";
import { copyPlainText } from "../data/clipboard";

/** Each receipt belongs to one copy operation and one committed text revision. */
export function CopyButton({ text, label = "复制", successLabel = "已复制" }: { text: string; label?: string; successLabel?: string }) {
  const [success, setSuccess] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const epoch = React.useRef(0);
  const mounted = React.useRef(false);
  React.useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; };
  }, []);
  React.useLayoutEffect(() => {
    // A → B → A is still a new revision: comparing only the final string is insufficient.
    epoch.current++;
    setSuccess(null);
  }, [text]);
  React.useEffect(() => {
    if (success === null) return;
    const timer = window.setTimeout(() => setSuccess(current => current === success ? null : current), 1800);
    return () => window.clearTimeout(timer);
  }, [success]);
  // 第29轮：成功态在文字前加对勾并描线（CSS，减弱动效时静止），颜色转成功色；文字与时长不变。
  return <Button variant="ghost" size="sm" loading={busy} aria-label={label} className="ice-copy-btn"
    data-copied={success !== null || undefined}
    onClick={async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      const operation = ++epoch.current;
      const current = () => mounted.current && epoch.current === operation;
      setBusy(true); setSuccess(null);
      try {
        await copyPlainText(text);
        if (current()) setSuccess(operation);
      } catch (error) {
        if (current()) {
          const feedback = errorDisplay(error);
          toast.error({ title: "复制失败", detail: [feedback.title, feedback.detail].filter(Boolean).join('：') });
        }
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    }}>{success !== null && <svg className="ice-copy-btn__check" key={success} width="14" height="14" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}{success !== null ? successLabel : label}<span className="ice-sr-only" role="status">{success !== null ? successLabel : ""}</span></Button>;
}
