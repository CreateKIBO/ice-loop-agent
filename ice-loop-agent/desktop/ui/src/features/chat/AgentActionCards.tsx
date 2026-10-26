// 行动卡（M5-06）：真实 agent_tool_calls 记录的展示——工具名、状态、耗时、
// 参数摘要、结果摘要；不伪造进度百分比。停止入口复用会话停止。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { rpc, type RpcError } from "../../data/client";
import { TOOL_LABEL } from "../../data/eventStream";
import { formatDuration } from "../../components/display";

type Card = {
  call_id: string; turn_id: string; tool: string; status: string;
  error_code: string | null; duration_ms: number | null;
  args_summary: string; result_summary: string; created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  succeeded: "完成", failed: "失败", invalid: "参数无效",
  unknown_tool: "未注册工具", running: "执行中",
};

// Agent 正在执行时快速刷新以看到每一步；空闲时放慢，避免每 3 秒两次无效读取。
const POLL_RUNNING_MS = 2_500;
const POLL_IDLE_MS = 12_000;

const STATUS_TONE: Record<string, string> = {
  succeeded: "success", failed: "danger", unknown_tool: "danger", invalid: "warning", running: "info",
};

export function AgentActionCards({ conversationId, refreshSignal = 0 }: {
  conversationId: string | null; refreshSignal?: number;
}) {
  const [runs, setRuns] = React.useState<Array<Record<string, unknown>> | null>(null);
  const [cards, setCards] = React.useState<Card[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(true);

  React.useEffect(() => {
    if (!conversationId) { setRuns([]); setCards([]); return; }
    let cancelled = false;
    let timer: number | undefined;
    // setTimeout 链而不是 setInterval：上一轮请求没回来前不会叠加新请求。
    // 工具事件到来时递增 refreshSignal，立即再拉一次，不必等下个轮询周期。
    const tick = async () => {
      let running = false;
      try {
        const data = await rpc<{ runs: Array<Record<string, unknown>> }>(
          "agent.runs_list", { conversation_id: conversationId });
        if (cancelled) return;
        setRuns(data.runs);
        const latest = data.runs[0];
        running = latest?.status === "running";
        if (latest) {
          const detail = await rpc<{ cards: Card[] }>(
            "agent.tool_calls_list", { run_id: String(latest.run_id) });
          if (!cancelled) setCards(detail.cards);
        } else if (!cancelled) setCards([]);
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError((err as RpcError).message);
      }
      if (!cancelled) timer = window.setTimeout(tick, running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [conversationId, refreshSignal]);

  if (!conversationId || !runs?.length) return null;
  const latestStatus = String(runs[0]?.status ?? "");
  const failedCount = cards.filter(card => STATUS_TONE[card.status] === "danger").length;
  return (
    <section aria-label="Agent 行动记录" style={{ display: "grid", gap: 6, padding: "0 var(--ice-space-4) var(--ice-space-2)" }}>
      <button type="button" className="ice-link-btn ice-link-btn--muted" aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
              style={{ justifySelf: "start", display: "inline-flex", gap: 6, alignItems: "center" }}>
        <motion.span aria-hidden animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.16 }}
                     style={{ display: "inline-block" }}>▸</motion.span>
        Agent 最近一次行动：{cards.length} 步
        {latestStatus === "running" && <span className="ice-badge ice-badge--info">执行中</span>}
        {failedCount > 0 && <span className="ice-badge ice-badge--danger">{failedCount} 步失败</span>}
      </button>
      {error && <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>行动记录加载失败：{error}</div>}
      <AnimatePresence initial={false}>
      {expanded && (
      <motion.div key="cards" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                  style={{ overflow: "hidden" }}>
      <div style={{ display: "grid", gap: 6, maxHeight: 200, overflowY: "auto" }}>
      <AnimatePresence initial={false}>
      {cards.map(card => (
        <motion.div key={card.call_id} className="ice-card ice-card--compact"
             initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
             style={{ fontSize: "var(--ice-font-size-sm)", gap: 2, padding: "6px 10px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <strong>{TOOL_LABEL[card.tool] ?? card.tool}</strong>
            <span className={"ice-badge" + (STATUS_TONE[card.status] ? ` ice-badge--${STATUS_TONE[card.status]}` : "")}>
              {STATUS_LABEL[card.status] ?? card.status}
            </span>
            {card.duration_ms !== null && (
              <span style={{ color: "var(--ice-text-secondary)" }}>{formatDuration(card.duration_ms)}</span>
            )}
          </div>
          {card.error_code && <div style={{ color: "var(--ice-danger)" }}>{card.error_code}: {card.result_summary || card.args_summary}</div>}
          {card.args_summary && !card.error_code && (
            <div style={{ color: "var(--ice-text-secondary)", overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                 title={card.args_summary}>参数：{card.args_summary}</div>
          )}
          {card.result_summary && !card.error_code && (
            <div style={{ color: "var(--ice-text-secondary)", overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                 title={card.result_summary}>结果：{card.result_summary}</div>
          )}
        </motion.div>
      ))}
      </AnimatePresence>
      </div>
      </motion.div>
      )}
      </AnimatePresence>
    </section>
  );
}
