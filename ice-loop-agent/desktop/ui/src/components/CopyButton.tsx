import * as React from "react";
import { Button } from "./ui";
import { toast } from "./toast";
import { copyPlainText } from "../data/clipboard";

export function CopyButton({ text, label = "复制", successLabel = "已复制" }: { text: string; label?: string; successLabel?: string }) {
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Button variant="ghost" size="sm" disabled={busy} aria-label={label}
    onClick={async () => {
      setBusy(true);
      try { await copyPlainText(text); setCopied(true); }
      catch (error) { toast.error({ title: "复制失败", detail: (error as Error).message }); }
      finally { setBusy(false); }
    }}>{copied ? successLabel : label}<span className="ice-sr-only" role="status">{copied ? successLabel : ""}</span></Button>;
}
