// v3.11：讨论结束后，在最新一条讨论回复下方给出“写初稿”。
// 点击即以初稿模式发送一条说明（随会话历史一起交给模型），不必手动切换模式、再输入要求。
import * as React from "react";
import { motion } from "motion/react";

import { Button } from "../../components/ui";
import { useActivityReducedMotion } from "../../components/ActivityRail";
import type { ChatDelivery } from "./useChatDelivery";
import { draftRequestText } from "./draftRequest";

export function DraftFromDiscussion({ delivery, disabled }: { delivery: ChatDelivery; disabled: boolean }) {
  const reduced = useActivityReducedMotion();
  const [open, setOpen] = React.useState(false);
  const [extra, setExtra] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const blocked = disabled || busy || delivery.busy || Boolean(delivery.pending);
  const start = async () => {
    if (blocked) return;
    setBusy(true);
    try {
      await delivery.send({ text: draftRequestText(extra), mode: "draft" }, "composer");
      setExtra(""); setOpen(false);
    } catch { /* 发送失败由会话的投递提示统一显示，输入保留 */ }
    finally { setBusy(false); }
  };
  return (
    <motion.section className="ice-draft-cta" aria-label="根据讨论写初稿"
      initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
      <div className="ice-draft-cta__row">
        <span className="ice-draft-cta__hint">讨论得差不多了？让助手按以上结论写出完整初稿，生成后由你决定是否存为文章。</span>
        <button type="button" className="ice-link-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? "收起要求" : "加点要求"}</button>
        <Button size="sm" variant="primary" loading={busy} disabled={blocked} onClick={() => void start()}>写初稿</Button>
      </div>
      {open && <textarea className="ice-draft-cta__extra" rows={2} maxLength={500} value={extra} aria-label="初稿的补充要求"
        placeholder="可选：例如 1500 字左右、分 4 个小标题、结尾留一个互动问题"
        onChange={event => setExtra(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }} />}
    </motion.section>
  );
}
