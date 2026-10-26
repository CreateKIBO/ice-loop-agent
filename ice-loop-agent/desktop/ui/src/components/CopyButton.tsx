import * as React from "react";
import { Button } from "./ui";
import { toast } from "./toast";
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
  return <Button variant="ghost" size="sm" loading={busy} aria-label={label}
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
        if (current()) toast.error({ title: "复制失败", detail: (error as Error).message });
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    }}>{success !== null ? successLabel : label}<span className="ice-sr-only" role="status">{success !== null ? successLabel : ""}</span></Button>;
}
