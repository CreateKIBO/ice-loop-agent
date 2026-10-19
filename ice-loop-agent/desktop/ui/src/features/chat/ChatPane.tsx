// 中栏对话面板（M2-07/M2-09 基础）：消息时间线 + 输入框。
// IME 纪律：composition（中文输入法组词）期间 Enter 不发送；不重建输入根。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { useVirtualizer } from '@tanstack/react-virtual';

import { Button, ErrorPanel, SkeletonRows } from "../../components/ui";
import { toast } from "../../components/toast";
import { settingsStore } from "../../app/uiState";
import { citationStore, queryClient, rpc, useAccountMutation, useAccountQuery, useCitations, useCurrentAccount, useEventStream, type RpcError } from "../../data/client";
import { formatElapsed, phaseFromMetadata, toolSignal, turnSteps, type StreamEvent } from "../../data/eventStream";
import { AgentActionCards } from "./AgentActionCards";
import { ConversationHeader } from "./ConversationHeader";
import { CopyButton } from "../../components/CopyButton";
import { MarkdownContent } from "../../components/MarkdownContent";
import { appendComposerText, composerKey, loadComposerDraft, mayClearAcknowledgedInput, saveComposerDraft, shouldSendKey,
  peekStagedComposerDraft,acknowledgeStagedComposerDraft,type ComposerMode } from "../../data/composerDraft";
import { idleChatPollingInterval, isNearBottom, unreadAssistantUpdates } from "./readingState";
import type { ChatMessage, ChatResult } from "../../data/workbenchResponses";
import { MESSAGE_WINDOW, CANDIDATE_WINDOW, messagePosition, estimateMessage, type HistoryPosition, type CandidatePosition } from './historyWindow';

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
// 距底部不超过该距离视为"正在跟随最新消息"。

export function ChatPane({ conversationId }: { conversationId: string | null }) {
  const [sending, setSending] = React.useState(false);
  const [position, setPosition] = React.useState<HistoryPosition | null>(null);
  const [readingSnapshot, setReadingSnapshot] = React.useState<ChatResult | null>(null);
  const latest = useAccountQuery<ChatResult>("chat.get",
    conversationId ? { conversation_id: conversationId, message_limit: MESSAGE_WINDOW, candidate_limit: CANDIDATE_WINDOW } : undefined,
    {
      enabled: Boolean(conversationId),
      refetchInterval: sending ? POLL_STREAMING_MS : idleChatPollingInterval,
      gcTime: 0,
    });
  // Only the currently displayed history window is retained. Live polling
  // continues independently so a new reply cannot replace the page being read.
  const history = useAccountQuery<ChatResult>('chat.get',
    { conversation_id: conversationId, message_limit: MESSAGE_WINDOW, candidate_limit: 1, ...position },
    { enabled: Boolean(conversationId && position), gcTime: 0, staleTime: Infinity });
  const messages = position ? history : { ...latest, data: readingSnapshot ?? latest.data };

  const rows = messages.data?.messages ?? [];
  const streaming = isStreaming(latest.data);

  // 自动滚动：只在用户本来就在底部附近时跟随，用户向上翻阅历史时不抢滚动条。
  const logRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const seen = React.useRef(new Map<string, string>());
  const scrollIntentUntil = React.useRef(0);
  const [away, setAway] = React.useState(false);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => logRef.current,
    estimateSize: index => estimateMessage(rows[index].content),
    getItemKey: index => rows[index].id, overscan: 2,
  });
  const onScroll = () => {
    const node = logRef.current;
    if (!node) return;
    const atBottom = isNearBottom(node.scrollHeight, node.scrollTop, node.clientHeight);
    const intended = Date.now() < scrollIntentUntil.current;
    scrollIntentUntil.current = 0;
    // Virtual rows change their measured height after Markdown mounts. Those
    // programmatic scroll events must not be mistaken for a reader scrolling up.
    if (position) following.current = false;
    else if (atBottom) { following.current = true; setReadingSnapshot(null); }
    else if (intended) {
      following.current = false;
      // Pin the reading window before the latest 40-row slice advances. A new
      // reply must not evict the message currently being read at its upper edge.
      if (!readingSnapshot && latest.data) setReadingSnapshot(latest.data);
    }
    if (following.current) seen.current = new Map(rows.map(row => [row.id, row.content]));
    setAway(!following.current);
  };
  const scrollIntent = () => {
    const node = logRef.current;
    if (rows.length && node && node.scrollHeight > node.clientHeight) scrollIntentUntil.current = Date.now() + 1500;
  };
  React.useLayoutEffect(() => { following.current = true; seen.current.clear(); setAway(false); }, [conversationId]);
  React.useLayoutEffect(() => {
    const node = logRef.current;
    if (node && following.current) {
      node.scrollTop = node.scrollHeight;
      seen.current = new Map(rows.map(row => [row.id, row.content]));
    }
  }, [rows, streaming, conversationId]);
  const unread = away ? unreadAssistantUpdates(latest.data?.messages ?? [], seen.current) : 0;
  React.useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (following.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
    observer.observe(node);
    if (logRef.current) observer.observe(logRef.current);
    return () => observer.disconnect();
  }, [conversationId, messages.isError]);
  const jumpToLatest = () => {
    setPosition(null);
    setReadingSnapshot(null);
    scrollIntentUntil.current = 0;
    following.current = true; seen.current = new Map(rows.map(row => [row.id, row.content])); setAway(false);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  const browse = (direction: 'older' | 'newer') => {
    const next = messagePosition(messages.data?.message_page, direction);
    if (!next) return;
    following.current = false; setAway(true);
    setReadingSnapshot(null);
    setPosition(next);
    if (logRef.current) logRef.current.scrollTop = 0;
  };
  const [reuse, setReuse] = React.useState<{ id: number; text: string } | null>(null);

  // 打开会话时已有的历史直接显示；之后新到的消息才做入场动画，避免整屏历史一起"飞入"。
  const historyIds = React.useRef<Set<string> | null>(null);
  if (historyIds.current === null && messages.data) historyIds.current = new Set(rows.map(row => row.id));
  const streamingRow = latest.data?.messages.find(row => row.status === "streaming");
  const account = useCurrentAccount();
  const events = useEventStream(conversationId ? "chat:" + conversationId : null, streaming || sending);
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
  if (messages.error && !position && !readingSnapshot) {
    return <div style={{ padding: "var(--ice-space-4)" }}>
      <ErrorPanel title="会话加载失败" detail={(messages.error as RpcError).message}
                  onRetry={() => messages.refetch()} />
    </div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%", minHeight: 0 }}>
      <ConversationHeader conversation={latest.data?.conversation} streaming={streaming || sending} />
      {(position || messages.data?.message_page?.has_older) && <nav className="ice-chat-history" aria-label="历史消息翻页">
        <Button size="sm" disabled={!messages.data?.message_page?.has_older || messages.isFetching} onClick={() => browse('older')}>更早的消息</Button>
        <span>{position ? '正在阅读历史 · 每页最多 40 条' : '最近 40 条 · 完整历史按需读取'}</span>
        {position && <>
          <Button size="sm" disabled={!messages.data?.message_page?.has_newer || messages.isFetching} onClick={() => browse('newer')}>更新的消息</Button>
          <Button size="sm" onClick={jumpToLatest}>回到最新</Button>
        </>}
      </nav>}
      <div className="ice-chat-reading">
      <div ref={logRef} onScroll={onScroll} onWheel={scrollIntent}
           onPointerDown={event => { if (event.target === event.currentTarget) scrollIntent(); }}
           onPointerMove={event => { if (event.buttons === 1) scrollIntent(); }}
           onTouchStart={scrollIntent} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) scrollIntent(); }}
           className="ice-chat-log" role="log" tabIndex={0}
           aria-label="对话记录" aria-relevant="additions"
           style={{ padding: "var(--ice-space-4)" }}>
        <div ref={contentRef} style={{ display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:"var(--ice-space-3)",alignContent:"start" }}>
        {messages.isLoading && <SkeletonRows rows={5} height={28} gap={16} />}
        {position && messages.error && <ErrorPanel title="历史读取失败" detail={messages.error.message} onRetry={() => messages.refetch()} />}
        {!messages.isLoading && rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--ice-text-secondary)", padding: "var(--ice-space-7) 0" }}>
            <div style={{ fontWeight: 600, color: "var(--ice-text)", marginBottom: 6 }}>新的会话</div>
            说说你想写什么：一个选题、一段素材，或者一篇想改的旧文。
          </div>
        )}
        <div style={{ height: virtual.getTotalSize(), position: 'relative', width: '100%' }} data-chat-window-size={rows.length}>
          {virtual.getVirtualItems().map(item => {
            const row = rows[item.index];
            return <div key={row.id} data-index={item.index} data-message-id={row.id} ref={virtual.measureElement}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)`, paddingBottom: 12, boxSizing: 'border-box' }}>
              <MessageBubble row={row} animateIn={!position && !historyIds.current?.has(row.id)}
                onReuse={() => setReuse({ id: Date.now(), text: row.content })} />
            </div>;
          })}
        </div>
        <AnimatePresence>
          {streaming && (
            <motion.div key="typing" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <TurnProgress events={events} turnId={streamingRow?.id ?? ""} metadata={streamingRow?.metadata} />
            </motion.div>
          )}
        </AnimatePresence>
        <CandidateHistory conversationId={conversationId} latest={latest.data} refresh={() => latest.refetch()} />
        </div>
      </div>
      <AnimatePresence>
        {away && <motion.div className="ice-jump-latest" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          <Button size="sm" onClick={jumpToLatest}>↓ {unread ? `${unread} 条回复有更新 · 回到最新` : "回到最新"}</Button>
        </motion.div>}
      </AnimatePresence>
      </div>
      <AgentActionCards conversationId={conversationId} refreshSignal={toolSeq} />
      <Composer key={account + ":" + conversationId} conversationId={conversationId} streaming={streaming} reuse={reuse} onSending={setSending} />
    </div>
  );
}

type CandidateView = {
  id: string; title: string; body: string; status: string;
  content_hash: string; prompts: string[];
  saved_draft?: { draft_id: string; changed: boolean } | null;
};

function CandidateHistory({ conversationId, latest, refresh }: {
  conversationId: string; latest?: ChatResult; refresh: () => Promise<unknown>;
}) {
  const [position, setPosition] = React.useState<CandidatePosition | null>(null);
  const query = useAccountQuery<ChatResult>('chat.get', {
    conversation_id: conversationId, message_limit: 1, candidate_limit: CANDIDATE_WINDOW, ...position,
  }, { enabled: Boolean(position), gcTime: 0 });
  const data = position ? query.data : latest;
  const page = data?.candidate_page;
  const candidates = (data?.candidates ?? []) as CandidateView[];
  if (!position && !candidates.length) return null;
  return <section className="ice-chat-candidates" aria-label="会话候选稿">
    <div className="ice-chat-history">
      <strong>{position ? '历史候选稿' : '最近候选稿'}</strong>
      {page?.has_older && <Button size="sm" disabled={query.isFetching} onClick={() => setPosition({ before_candidate_id: page.oldest_id! })}>更早的候选稿</Button>}
      {position && <>
        {page?.has_newer && <Button size="sm" disabled={query.isFetching} onClick={() => setPosition({ after_candidate_id: page.newest_id! })}>更新的候选稿</Button>}
        <Button size="sm" onClick={() => setPosition(null)}>最近候选稿</Button>
      </>}
    </div>
    {position && query.isLoading && <SkeletonRows rows={2} />}
    {position && query.error && <ErrorPanel title="候选稿读取失败" detail={query.error.message} onRetry={() => query.refetch()} />}
    {candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate}
      onChanged={async () => { await refresh(); if (position) await query.refetch(); }} />)}
  </section>;
}

/** R12 批次二：初稿候选 → 显示正文 → 保存为草稿 → 提交审阅。保存 ≠ 采纳。 */
function CandidateCard({ candidate, onChanged }: { candidate: CandidateView; onChanged: () => Promise<unknown> }) {
  const account = useCurrentAccount();
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "submit" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const saved = candidate.saved_draft;
  const readOnly = !['draft', 'pending'].includes(candidate.status);
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
        {readOnly && <span>{({ accepted: '已采纳', rejected: '已拒绝' } as Record<string, string>)[candidate.status] ?? candidate.status}</span>}
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
        <Button loading={busy === "save"} disabled={busy !== null || readOnly} onClick={saveDraft}>保存为草稿</Button>
        <Button variant="primary" loading={busy === "submit"} disabled={busy !== null || !saved || candidate.status === "pending" || readOnly}
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

function MessageBubble({ row, animateIn, onReuse }: { row: ChatMessage; animateIn: boolean; onReuse: () => void }) {
  const isUser = row.role === "user";
  if (!row.content && row.status === "streaming") return null; // 空的生成中消息由打字指示代替
  return (
    <motion.div initial={animateIn ? { opacity: 0, y: 10, x: isUser ? 12 : -12 } : false}
                animate={{ opacity: 1, y: 0, x: 0 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}
                className={"ice-message" + (isUser ? " ice-message--user" : "")}
                style={{ display: "grid", gap: 4, justifyItems: isUser ? "end" : "start", minWidth: 0 }}>
      <span className="ice-message__speaker">{isUser ? "你" : "创作助手"}</span>
      <div style={{
        maxWidth: isUser ? "min(640px, 92%)" : "100%", minWidth: 0, boxSizing: "border-box",
        width: isUser ? undefined : "100%", padding: "var(--ice-space-2) var(--ice-space-3)",
        borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px", whiteSpace: isUser ? "pre-wrap" : "normal", overflowWrap: "anywhere",
        lineHeight: 1.65, background: isUser ? "var(--ice-info-bg)" : "var(--ice-surface)",
        border: `1px solid ${isUser ? "transparent" : "var(--ice-border)"}`,
        boxShadow: isUser ? "none" : "0 1px 2px rgba(21, 25, 31, 0.04)",
      }}>
        {isUser ? row.content : <MarkdownContent text={row.content} />}
        {row.status === "streaming" && <span className="ice-caret" aria-hidden />}
      </div>
      {row.content && row.status !== "streaming" && <div className="ice-message__actions">
        <CopyButton text={row.content} label="复制消息" />
        {isUser && <Button variant="ghost" size="sm" onClick={onReuse}>再次使用</Button>}
      </div>}
      {!isUser && <InputContextReceipt value={row.metadata?.input_manifest} />}
      {END_NOTE[row.status] && (
        <span style={{ fontSize: "var(--ice-font-size-sm)",
                       color: row.status === "failed" ? "var(--ice-danger)" : "var(--ice-text-secondary)" }}>
          {END_NOTE[row.status]}
        </span>
      )}
    </motion.div>
  );
}

function InputContextReceipt({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null;
  const data = value as { version?: number; text_characters?: number; history_sources?: unknown };
  if (data.version !== 1 || !Array.isArray(data.history_sources) || !Number.isSafeInteger(data.text_characters)) return null;
  const sources = data.history_sources.filter((row): row is { title_count: number; full_body_count: number } =>
    row && typeof row === 'object' && Number.isSafeInteger(row.title_count) && row.title_count >= 0 &&
    Number.isSafeInteger(row.full_body_count) && row.full_body_count >= 0);
  if (!sources.length) return null;
  const titles = sources.reduce((total, row) => total + row.title_count, 0);
  const bodies = sources.reduce((total, row) => total + row.full_body_count, 0);
  return <details className="ice-context-receipt">
    <summary>写作依据 · {titles.toLocaleString()} 个历史标题 · {bodies} 篇全文</summary>
    <p>历史标题完整保留，前文按所选期号读取。标题表采用紧凑格式，正文没有截断。</p>
    <p>本轮初始请求含 {data.text_characters!.toLocaleString()} 个文本字符（含系统要求、对话与资料）。字符数不等同于 Token，模型窗口仍以供应商实际限制为准。</p>
  </details>;
}

function Composer({ conversationId, streaming, reuse, onSending }: { conversationId: string; streaming: boolean; reuse: { id: number; text: string } | null; onSending: (pending: boolean) => void }) {
  const account = useCurrentAccount();
  const inputKey = composerKey(account, conversationId);
  const [initial] = React.useState(() => {
    const staged=peekStagedComposerDraft(account,conversationId);
    if(staged)return staged;
    try {
      const draft = loadComposerDraft(window.localStorage, account, conversationId);
      if (!draft.text) draft.text = window.sessionStorage.getItem("ice.composer:" + account + ":" + conversationId) ?? "";
      return draft;
    } catch { return { text: "", mode: "discuss" as ComposerMode }; }
  });
  React.useEffect(()=>acknowledgeStagedComposerDraft(account,conversationId),[account,conversationId]);
  const [text, setText] = React.useState(initial.text);
  const [mode, setMode] = React.useState<ComposerMode>(initial.mode);
  const [persisted, setPersisted] = React.useState(true);
  const [restored, setRestored] = React.useState(Boolean(initial.text));
  const revision = React.useRef(0);
  const scope = React.useRef(inputKey);
  scope.current = inputKey;
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const updateText = (value: string) => { revision.current++; setRestored(false); setText(value); };
  React.useEffect(() => {
    let ok = false;
    try {
      ok = saveComposerDraft(window.localStorage, account, conversationId, { text, mode });
      if (ok) window.sessionStorage.removeItem("ice.composer:" + account + ":" + conversationId);
    } catch { /* Input remains editable even when storage is unavailable. */ }
    setPersisted(ok);
  }, [account, conversationId, text, mode]);
  React.useLayoutEffect(() => {
    const node = inputRef.current;
    if (node) { node.style.height = "auto"; node.style.height = Math.min(190, Math.max(72, node.scrollHeight)) + "px"; }
  }, [text]);
  React.useEffect(() => {
    if (!reuse) return;
    revision.current++; setRestored(false); setText(current => appendComposerText(current, reuse.text));
    inputRef.current?.focus();
  }, [reuse]);
  const composing = React.useRef(false);
  const citations = useCitations();
  const [stopping, setStopping] = React.useState(false);
  const overLimit = text.trim().length > 12000;

  const send = useAccountMutation<{ text: string; mode: string; citations: Array<{ chunk_id: string; hash: string }> }>("chat.send", {
    // 发送成功立刻刷新会话：用户自己的消息和"生成中"状态不再靠轮询才出现。
    invalidate: [["chat.get"]],
    transform: vars => ({ conversation_id: conversationId, text: vars.text, mode: vars.mode,
                         citations: vars.citations }),
  });
  React.useEffect(() => { onSending(send.isPending); }, [send.isPending, onSending]);

  const submit = () => {
    const trimmed = text.trim();
    // 生成期间输入框仍可输入（草稿保留），但不允许并发发送。
    if (!trimmed || overLimit || send.isPending || streaming) return;
    const submittedRevision = revision.current, submittedScope = inputKey;
    // R11：手选引文随发送提交（chunk_id + 内容 hash），后端按账号重读并校验。
    const citationsPayload = citations.map(citation => ({
      chunk_id: citation.chunkId, hash: citation.hash,
    }));
    send.mutate({ text: trimmed, mode, citations: citationsPayload }, {
      onSuccess: () => {
        if (mayClearAcknowledgedInput(submittedRevision, revision.current, submittedScope, scope.current)) {
          setText(""); setRestored(false);
        }
      },
      // 失败保留输入（对象级 dirty 原则：网络失败不清空用户输入）。
      onError: err => {
        const message = (err as RpcError).message ?? "";
        if ((err as RpcError).code === "MODEL_BUDGET_EXCEEDED" || /模型调用.*上限/.test(message) || message.includes("MODEL_BUDGET_EXCEEDED")) {
          toast.error({ title: "本会话模型调用已达上限", detail: message,
                        action: { label: "打开预算设置", run: () => settingsStore.set(true) } });
        }
      },
    });
  };

  return (
    <div className="ice-composer">
      <div className="ice-composer__modes" role="group" aria-label="创作模式">
        {MODES.map(option => <button key={option.value} type="button" aria-pressed={mode === option.value}
          onClick={() => { revision.current++; setMode(option.value); }}>
          {mode === option.value && <motion.span layoutId={"composer-mode:" + inputKey} className="ice-segmented__pill" transition={{ type:"spring",stiffness:500,damping:36 }} />}
          <span className="ice-segmented__label">{option.label}</span>
        </button>)}
        <span className="ice-composer-note">{mode === "draft" ? "生成候选后，由你决定保存和审阅" : mode === "edit" ? "讨论修改，确认后同步文章" : mode === "images" ? "整理图位和配图提示词" : "讨论选题、素材与观点"}</span>
      </div>
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
        ref={inputRef}
        value={text}
        onChange={event => updateText(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          // IME 组词期间 Enter 是候选确认，不是发送。
          if (shouldSendKey({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
                              isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, composing.current)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={streaming ? "上一条回复仍在生成，可先写下一条，完成后再发送" : "输入消息，Enter 发送，Shift+Enter 换行"}
        rows={2}
        autoFocus
        aria-label="消息输入"
        aria-invalid={overLimit || undefined}
        aria-describedby="ice-composer-help"
      />
      <div className="ice-composer__footer">
        <span id="ice-composer-help" className={"ice-composer-note" + (!persisted || overLimit ? " ice-error-text" : "")}>
          {overLimit ? "消息超过 12000 字符，请分段发送" : !persisted ? "本地保存失败，请保留此窗口或复制输入" : restored ? "已恢复上次未发送内容" : "Enter 发送 · Shift+Enter 换行"}
          {text.length > 0 && <span> · {text.length} 字符</span>}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="primary" loading={send.isPending}
                disabled={streaming || overLimit || !text.trim()}
                onClick={submit}>发送</Button>
        {(streaming || send.isPending) && (
          <Button variant="secondary" loading={stopping} onClick={async () => {
            setStopping(true);
            try { await rpc("chat.stop", { conversation_id: conversationId }); toast.info("已请求停止，正在等待引擎结束当前步骤"); }
            catch (error) { toast.error({ title:"停止失败", detail:(error as Error).message }); }
            finally { setStopping(false); }
          }}>停止</Button>
        )}
      </div>
    </div>
  );
}
