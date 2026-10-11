// 中栏对话面板（M2-07/M2-09 基础）：消息时间线 + 输入框。
// IME 纪律：composition（中文输入法组词）期间 Enter 不发送；不重建输入根。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, ErrorPanel, SkeletonRows } from "../../components/ui";
import { toast } from "../../components/toast";
import { settingsStore } from "../../app/uiState";
import { citationStore, queryClient, rpc, useAccountMutation, useAccountQuery, useCitations, useCurrentAccount, useEventStream, type RpcError } from "../../data/client";
import { formatElapsed, phaseFromMetadata, toolSignal, turnSteps, type StreamEvent } from "../../data/eventStream";
import { AgentActionCards } from "./AgentActionCards";
import type { ChatMessage, ChatResult } from "../../data/workbenchResponses";

const MODES = [
  { value: "discuss", label: "讨论" },
  { value: "draft", label: "初稿" },
  { value: "edit", label: "改稿" },
  { value: "images", label: "配图" },
] as const;

const isStreaming = (result: ChatResult | undefined) =>
  (result?.messages ?? []).some(row => row.status === "streaming");

// 生成中快速轮询看到流式增量；空闲时放慢，避免本地引擎被无意义地反复读库。
// 用户自己发送后由 Composer 主动失效缓存，不依赖轮询来显示新消息。
const POLL_STREAMING_MS = 1_500;
const POLL_IDLE_MS = 8_000;
// 距底部不超过该距离视为"正在跟随最新消息"。
const STICK_THRESHOLD_PX = 80;

export function ChatPane({ conversationId }: { conversationId: string | null }) {
  const messages = useAccountQuery<ChatResult>("chat.get",
    conversationId ? { conversation_id: conversationId } : undefined,
    {
      enabled: Boolean(conversationId),
      refetchInterval: query => (isStreaming(query.state.data) ? POLL_STREAMING_MS : POLL_IDLE_MS),
    });

  const rows = messages.data?.messages ?? [];
  const streaming = isStreaming(messages.data);
  const candidates = (messages.data?.candidates ?? []) as CandidateView[];
  const draftCandidates = candidates.filter(candidate => ["draft", "pending"].includes(candidate.status)).slice(0, 3);

  // 自动滚动：只在用户本来就在底部附近时跟随，用户向上翻阅历史时不抢滚动条。
  const logRef = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const onScroll = () => {
    const node = logRef.current;
    if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX;
  };
  React.useEffect(() => { following.current = true; }, [conversationId]);
  const lastRow = rows[rows.length - 1];
  const tail = `${rows.length}:${lastRow?.content.length ?? 0}:${streaming}:${draftCandidates.length}`;
  React.useLayoutEffect(() => {
    const node = logRef.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [tail, conversationId]);

  // 打开会话时已有的历史直接显示；之后新到的消息才做入场动画，避免整屏历史一起"飞入"。
  const historyIds = React.useRef<Set<string> | null>(null);
  if (historyIds.current === null && messages.data) historyIds.current = new Set(rows.map(row => row.id));
  const streamingRow = rows.find(row => row.status === "streaming");
  const account = useCurrentAccount();
  const events = useEventStream(conversationId ? "chat:" + conversationId : null, streaming);
  // 轮次结束事件一到就刷新会话，不等下一个 chat.get 轮询周期。
  const finishedSeq = React.useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === "turn.finished") return events[index].sequence;
    }
    return 0;
  }, [events]);
  const seenFinished = React.useRef(finishedSeq);
  React.useEffect(() => {
    if (finishedSeq <= seenFinished.current) return;
    seenFinished.current = finishedSeq;
    void queryClient.invalidateQueries({ queryKey: ["ice", account, "chat.get"] });
  }, [finishedSeq, account]);
  const toolSeq = toolSignal(events);

  if (!conversationId) return null;
  if (messages.error) {
    return <div style={{ padding: "var(--ice-space-4)" }}>
      <ErrorPanel title="会话加载失败" detail={(messages.error as RpcError).message}
                  onRetry={() => messages.refetch()} />
    </div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%", minHeight: 0 }}>
      <div ref={logRef} onScroll={onScroll} className="ice-chat-log" role="log"
           aria-label="对话记录" aria-relevant="additions"
           style={{ padding: "var(--ice-space-4)", display: "grid",
                    gap: "var(--ice-space-3)", alignContent: "start" }}>
        {messages.isLoading && <SkeletonRows rows={5} height={28} gap={16} />}
        {!messages.isLoading && rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--ice-text-secondary)", padding: "var(--ice-space-7) 0" }}>
            <div style={{ fontWeight: 600, color: "var(--ice-text)", marginBottom: 6 }}>新的会话</div>
            说说你想写什么：一个选题、一段素材，或者一篇想改的旧文。
          </div>
        )}
        {rows.map(row => (
          <MessageBubble key={row.id} row={row} animateIn={!historyIds.current?.has(row.id)} />
        ))}
        <AnimatePresence>
          {streaming && (
            <motion.div key="typing" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <TurnProgress events={events} turnId={streamingRow?.id ?? ""} metadata={streamingRow?.metadata} />
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {draftCandidates.map(candidate => (
            <motion.div key={candidate.id} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.98 }} transition={{ type: "spring", stiffness: 360, damping: 30 }}>
              <CandidateCard candidate={candidate} onChanged={() => messages.refetch()} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <AgentActionCards conversationId={conversationId} refreshSignal={toolSeq} />
      <Composer key={conversationId} conversationId={conversationId} streaming={streaming} />
    </div>
  );
}

type CandidateView = {
  id: string; title: string; body: string; status: string;
  content_hash: string; prompts: string[];
  saved_draft?: { draft_id: string; changed: boolean } | null;
};

/** R12 批次二：初稿候选 → 显示正文 → 保存为草稿 → 提交审阅。保存 ≠ 采纳。 */
function CandidateCard({ candidate, onChanged }: { candidate: CandidateView; onChanged: () => Promise<unknown> }) {
  const account = useCurrentAccount();
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "submit" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const saved = candidate.saved_draft;
  const saveDraft = async () => {
    setBusy("save"); setError(null);
    try {
      await rpc("chat.save_draft", {
        candidate_id: candidate.id, content_hash: candidate.content_hash,
      });
      await onChanged();
      await queryClient.invalidateQueries({ queryKey: ["ice", account, "chat.drafts"] });
      toast.success({ title: "已保存为草稿", detail: "在左栏「草稿箱」可随时查看；保存不等于采纳" });
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(null); }
  };
  const submitReview = async () => {
    setBusy("submit"); setError(null);
    try {
      await rpc("chat.submit", { candidate_id: candidate.id, content_hash: candidate.content_hash });
      await onChanged();
      toast.success({ title: "已提交人工审阅", detail: "审阅通过前不会发布" });
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(null); }
  };
  return (
    <div role="region" aria-label="初稿候选" style={{
      border: "1px solid var(--ice-signal-blue)", borderRadius: "var(--ice-radius-lg)",
      padding: "var(--ice-space-3)", background: "var(--ice-surface)", display: "grid", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ flexShrink: 0 }}>初稿候选</strong>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", flex: 1, minWidth: 0,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={candidate.title}>
          {candidate.title}
        </span>
        {saved && <span style={{ fontSize: 12, color: "var(--ice-success)", flexShrink: 0 }}>
          已保存草稿{saved.changed ? "（有新修改未保存）" : ""}
        </span>}
      </div>
      <pre style={{ margin: 0, maxHeight: expanded ? 480 : 140, overflowY: "auto",
                    whiteSpace: "pre-wrap", fontFamily: "var(--ice-font-ui)",
                    background: "var(--ice-surface-muted)", padding: 10, borderRadius: 8,
                    fontSize: "var(--ice-font-size-sm)" }}>
        {candidate.body}
      </pre>
      {error && <div role="alert" style={{ color: "var(--ice-danger)", fontSize: "var(--ice-font-size-sm)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button loading={busy === "save"} disabled={busy !== null} onClick={saveDraft}>保存为草稿</Button>
        <Button variant="primary" loading={busy === "submit"} disabled={busy !== null || !saved || candidate.status === "pending"}
                title={saved ? "提交人工审阅（不自动发布）" : "请先保存为草稿"}
                onClick={submitReview}>{candidate.status === "pending" ? "已提交审阅" : "提交审阅"}</Button>
        <button type="button" className="ice-link-btn" aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起" : "展开全文"}
        </button>
        <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
          保存草稿 ≠ 采纳/发布
        </span>
      </div>
    </div>
  );
}

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** C1：生成中显示引擎事件里的真实步骤与已用时间；没有事件时退回消息元数据的阶段。 */
function TurnProgress({ events, turnId, metadata }: { events: StreamEvent[]; turnId: string; metadata: unknown }) {
  const progress = React.useMemo(() => turnSteps(events, turnId), [events, turnId]);
  const fallback = phaseFromMetadata(metadata);
  const startedAt = progress.startedAt ?? fallback?.startedAt;
  const now = useNow(true);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const label = progress.current?.label ?? fallback?.label ?? "正在生成…";
  const detail = progress.current?.detail;
  return (
    <div className="ice-turn-progress">
      <div className="ice-turn-progress__head">
        <span className="ice-typing" role="status" aria-label="生成中"><span /><span /><span /></span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                       exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}
                       className="ice-turn-progress__label" aria-live="polite">
            {label}{detail ? <span className="ice-turn-progress__detail"> · {detail}</span> : null}
          </motion.span>
        </AnimatePresence>
        {Number.isFinite(started) && (
          <span className="ice-turn-progress__elapsed" title="从发送到现在的真实耗时">
            已用 {formatElapsed(now - started)}
          </span>
        )}
      </div>
      {progress.steps.length > 1 && (
        <ol className="ice-turn-steps" aria-label="本轮步骤">
          <AnimatePresence initial={false}>
            {progress.steps.map(step => (
              <motion.li key={step.key} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                         transition={{ type: "spring", stiffness: 420, damping: 34 }}
                         className={"ice-turn-step ice-turn-step--" + step.status}
                         title={step.detail}>
                <span className="ice-turn-step__dot" aria-hidden />
                {step.label}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </div>
  );
}

const END_NOTE: Record<string, string> = {
  failed: "这条回复生成失败，可以重新发送",
  stopped: "已停止生成",
  interrupted: "应用关闭时中断，内容可能不完整",
};

function MessageBubble({ row, animateIn }: { row: ChatMessage; animateIn: boolean }) {
  const isUser = row.role === "user";
  if (!row.content && row.status === "streaming") return null; // 空的生成中消息由打字指示代替
  return (
    <motion.div initial={animateIn ? { opacity: 0, y: 10, x: isUser ? 12 : -12 } : false}
                animate={{ opacity: 1, y: 0, x: 0 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}
                style={{ display: "grid", gap: 4, justifyItems: isUser ? "end" : "start" }}>
      <div style={{
        maxWidth: "min(640px, 92%)", padding: "var(--ice-space-2) var(--ice-space-3)",
        borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px", whiteSpace: "pre-wrap",
        lineHeight: 1.65, background: isUser ? "var(--ice-info-bg)" : "var(--ice-surface)",
        border: `1px solid ${isUser ? "transparent" : "var(--ice-border)"}`,
        boxShadow: isUser ? "none" : "0 1px 2px rgba(21, 25, 31, 0.04)",
      }}>
        {row.content}
        {row.status === "streaming" && <span className="ice-caret" aria-hidden />}
      </div>
      {END_NOTE[row.status] && (
        <span style={{ fontSize: "var(--ice-font-size-sm)",
                       color: row.status === "failed" ? "var(--ice-danger)" : "var(--ice-text-secondary)" }}>
          {END_NOTE[row.status]}
        </span>
      )}
    </motion.div>
  );
}

function Composer({ conversationId, streaming }: { conversationId: string; streaming: boolean }) {
  const account = useCurrentAccount();
  const inputKey = "ice.composer:" + account + ":" + conversationId;
  const [text, setText] = React.useState(() => {
    try { return window.sessionStorage.getItem(inputKey) ?? ""; } catch { return ""; }
  });
  React.useEffect(() => {
    try {
      if (text) window.sessionStorage.setItem(inputKey, text);
      else window.sessionStorage.removeItem(inputKey);
    } catch { /* 当前输入仍可使用 */ }
  }, [inputKey, text]);
  const [mode, setMode] = React.useState<(typeof MODES)[number]["value"]>("discuss");
  const composing = React.useRef(false);
  const citations = useCitations();

  const send = useAccountMutation<{ text: string; mode: string; citations: Array<{ chunk_id: string; hash: string }> }>("chat.send", {
    // 发送成功立刻刷新会话：用户自己的消息和"生成中"状态不再靠轮询才出现。
    invalidate: [["chat.get"]],
    transform: vars => ({ conversation_id: conversationId, text: vars.text, mode: vars.mode,
                         citations: vars.citations }),
  });

  const submit = () => {
    const trimmed = text.trim();
    // 生成期间输入框仍可输入（草稿保留），但不允许并发发送。
    if (!trimmed || send.isPending || streaming) return;
    // R11：手选引文随发送提交（chunk_id + 内容 hash），后端按账号重读并校验。
    const citationsPayload = citations.map(citation => ({
      chunk_id: citation.chunkId, hash: citation.hash,
    }));
    send.mutate({ text: trimmed, mode, citations: citationsPayload }, {
      onSuccess: () => setText(current => current === text ? "" : current),
      // 失败保留输入（对象级 dirty 原则：网络失败不清空用户输入）。
      onError: err => {
        const message = (err as RpcError).message ?? "";
        if (message.includes("模型调用已达上限")) {
          toast.error({ title: "本会话模型调用已达上限", detail: message,
                        action: { label: "打开预算设置", run: () => settingsStore.set(true) } });
        }
      },
    });
  };

  return (
    <div style={{ borderTop: "1px solid var(--ice-border)", padding: "var(--ice-space-3)",
                  display: "grid", gap: "var(--ice-space-2)", background: "var(--ice-surface)" }}>
      {citations.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
             aria-label="已选引文">
          <span style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
            手选引文（进入上下文包）：
          </span>
          {citations.map(citation => (
            <span key={citation.chunkId} style={{
              fontSize: "var(--ice-font-size-sm)", padding: "2px 8px", borderRadius: 999,
              background: "var(--ice-info-bg)", display: "inline-flex", gap: 4, alignItems: "center",
            }}>
              {citation.displayName}
              <button onClick={() => citationStore.remove(citation.chunkId)}
                      aria-label={"移除引文 " + citation.displayName}
                      style={{ border: "none", background: "transparent", cursor: "pointer",
                               color: "var(--ice-text-secondary)" }}>×</button>
            </span>
          ))}
          <button type="button" className="ice-link-btn ice-link-btn--muted"
                  onClick={() => citationStore.clear()}>
            清空
          </button>
        </div>
      )}
      {send.error && (
        <div role="alert" style={{ color: "var(--ice-danger)", fontSize: "var(--ice-font-size-sm)" }}>
          发送失败：{(send.error as RpcError).message}（输入已保留，可直接重试）
        </div>
      )}
      <textarea
        value={text}
        onChange={event => setText(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          // IME 组词期间 Enter 是候选确认，不是发送。
          if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={streaming ? "上一条回复仍在生成，可先写下一条，完成后再发送" : "输入消息，Enter 发送，Shift+Enter 换行"}
        rows={3}
        autoFocus
        aria-label="消息输入"
        style={{
          resize: "vertical", minHeight: 64, padding: "var(--ice-space-2)",
          borderRadius: "var(--ice-radius-md)", border: "1px solid var(--ice-border)",
          background: "var(--ice-surface)", fontFamily: "var(--ice-font-ui)",
        }}
      />
      <div style={{ display: "flex", gap: "var(--ice-space-2)", alignItems: "center" }}>
        <label className="ice-sr-only" htmlFor="ice-mode-select">模式</label>
        <select id="ice-mode-select" value={mode} onChange={event => setMode(event.target.value as typeof mode)}
                style={{ height: "var(--ice-control-height)", borderRadius: "var(--ice-radius-md)",
                         border: "1px solid var(--ice-border)", background: "var(--ice-surface)" }}>
          {MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <Button variant="primary" loading={send.isPending}
                disabled={(streaming && !send.isPending) || (!send.isPending && !text.trim())}
                onClick={submit}>发送</Button>
        {streaming && (
          <Button variant="secondary" onClick={() => {
            rpc("chat.stop", { conversation_id: conversationId }).catch(() => { /* 下轮轮询反映状态 */ });
          }}>停止</Button>
        )}
      </div>
    </div>
  );
}
