// Bounded message window, event subscription and scroll coordination.
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, ErrorPanel, SkeletonRows } from "../../components/ui";
import { useActivityReducedMotion } from "../../components/ActivityRail";
import { queryClient, useAccountQuery, useCurrentAccount, useEventStream, type RpcError } from "../../data/client";
import { toolSignal } from "../../data/eventStream";
import { AgentActionCards } from "./AgentActionCards";
import { WindowFindBar } from "./WindowFindBar";
import { ConversationHeader } from "./ConversationHeader";
import { CandidateHistory } from "./CandidateHistory";
import { TurnProgress } from "./TurnProgress";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import {ClarificationForm} from "./ClarificationForm";
import {QuestionDock, pendingQuestionRow} from "./QuestionDock";
import {useChatDelivery} from "./useChatDelivery";
import {DraftFromDiscussion} from "./DraftFromDiscussion";
import {canDraftFrom} from "./draftRequest";
import { idleChatPollingInterval, isNearBottom, unreadAssistantUpdates } from "./readingState";
import type { ChatResult } from "../../data/workbenchResponses";
import { MESSAGE_WINDOW, CANDIDATE_WINDOW, messagePosition, estimateMessage, type HistoryPosition } from "./historyWindow";

const isStreaming = (result: ChatResult | undefined) =>
  (result?.messages ?? []).some(row => row.status === "streaming");

// 生成中快速轮询看到流式增量；空闲时放慢，避免本地引擎被无意义地反复读库。
// 用户自己发送后由 Composer 主动失效缓存，不依赖轮询来显示新消息。
const POLL_STREAMING_MS = 1_500;
// 距底部不超过该距离视为"正在跟随最新消息"。

export function ChatPane({ conversationId }: { conversationId: string | null }) {
  const account=useCurrentAccount();
  return <ConversationPane key={account+':'+(conversationId??'')} account={account} conversationId={conversationId} />;
}
function ConversationPane({conversationId,account}:{conversationId:string|null;account:string}) {
  const reduced = useActivityReducedMotion();
  const delivery=useChatDelivery(account,conversationId),sending=delivery.busy;
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
  const acceptedObserved=Boolean(delivery.acceptedId&&latest.data?.messages.some(row=>row.id===delivery.acceptedId));
  const streaming = isStreaming(latest.data)||Boolean(delivery.acceptedId&&!acceptedObserved);
  React.useEffect(()=>{
    if(acceptedObserved&&delivery.acceptedId)delivery.observeAccepted(delivery.acceptedId);
  },[acceptedObserved,delivery.acceptedId,delivery.observeAccepted]);

  // 自动滚动：只在用户本来就在底部附近时跟随，用户向上翻阅历史时不抢滚动条。
  const logRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const seen = React.useRef(new Map<string, string>());
  const scrollIntentUntil = React.useRef(0);
  const pendingLatest = React.useRef(false);
  const [away, setAway] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!reduced || !pendingLatest.current) return;
    pendingLatest.current = false;
    const node = logRef.current;
    node?.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
  }, [reduced]);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => logRef.current,
    estimateSize: index => estimateMessage(rows[index].content),
    getItemKey: index => rows[index].id, overscan: 2,
  });
  const onScroll = () => {
    const node = logRef.current;
    if (!node) return;
    if (node.scrollHeight - node.clientHeight - node.scrollTop <= 1) pendingLatest.current = false;
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
    const pending = pendingLatest.current; pendingLatest.current = false;
    if (pending && node) node.scrollTo({ top: node.scrollTop, behavior: 'instant' });
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
    pendingLatest.current = !reduced;
    setPosition(null);
    setReadingSnapshot(null);
    scrollIntentUntil.current = 0;
    following.current = true; seen.current = new Map(rows.map(row => [row.id, row.content])); setAway(false);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight,
      behavior: reduced ? "instant" : "smooth" });
  };
  const browse = (direction: 'older' | 'newer') => {
    const next = messagePosition(messages.data?.message_page, direction);
    if (!next) return;
    pendingLatest.current = false;
    following.current = false; setAway(true);
    setReadingSnapshot(null);
    setPosition(next);
    if (logRef.current) logRef.current.scrollTop = 0;
  };
  const [reuse, setReuse] = React.useState<{ id: number; text: string } | null>(null);
  // 批次3-21：当前阅读窗口内查找（只查已加载 rows，不称全历史检索）。
  const [findOpen, setFindOpen] = React.useState(false);
  const [findHighlight, setFindHighlight] = React.useState<string | null>(null);
  const locateFindHit = (id: string) => {
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) return;
    pendingLatest.current = false;
    // Searching is an explicit reading action. Pin the current page before
    // measurement or new replies can drag the viewport back to the live tail.
    following.current = false;
    scrollIntentUntil.current = 0;
    setAway(true);
    if (!position && !readingSnapshot && latest.data) setReadingSnapshot(latest.data);
    virtual.scrollToIndex(index, { align: "center" });
  };
  const closeFind = () => {
    setFindOpen(false); setFindHighlight(null);
    logRef.current?.closest('[data-chat-pane]')?.querySelector<HTMLButtonElement>('[data-find-trigger]')?.focus();
  };

  // 打开会话时已有的历史直接显示；之后新到的消息才做入场动画，避免整屏历史一起"飞入"。
  const historyIds = React.useRef<Set<string> | null>(null);
  if (historyIds.current === null && messages.data) historyIds.current = new Set(rows.map(row => row.id));
  const streamingRow = latest.data?.messages.find(row => row.status === "streaming");
  const latestAssistantId=latest.data?.messages.filter(message=>message.role==='assistant').at(-1)?.id;
  // v3.1：最新回复带有待答问题时，在输入框上方显示逐题提问框。
  const questionRow=pendingQuestionRow(latest.data?.messages);
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
  // A background read error still carries the last successful result. Replacing
  // the pane here would unmount CandidateHistory and discard expanded/source
  // state (including its independently loaded historical candidate page).
  if (messages.error && !messages.data && !position && !readingSnapshot) {
    return <div style={{ padding: "var(--ice-space-4)" }}>
      <ErrorPanel title="会话加载失败" detail={(messages.error as RpcError).message}
                  onRetry={() => messages.refetch()} />
    </div>;
  }

  return (
    <div data-chat-pane style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%", minHeight: 0 }}>
      {latest.error && latest.data && <div style={{ padding: "var(--ice-space-3)" }}>
        <ErrorPanel title="会话刷新失败，已保留当前内容" detail={latest.error.message}
                    onRetry={() => latest.refetch()} />
      </div>}
      <ConversationHeader conversation={latest.data?.conversation} streaming={streaming || sending}
                         findOpen={findOpen} onFind={() => { if (findOpen) closeFind(); else setFindOpen(true); }} />
      {findOpen && (
        <WindowFindBar rows={rows} onLocate={locateFindHit}
                       onHighlight={setFindHighlight} onClose={closeFind} />
      )}
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
           onTouchStart={scrollIntent} onKeyDown={event => { if (['Tab', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) scrollIntent(); }}
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
                highlighted={findHighlight === row.id}
                onReuse={() => setReuse({ id: Date.now(), text: row.content })}
                retryDisabled={streaming||delivery.busy||Boolean(delivery.pending)}
                onRetry={()=>void delivery.send({retry_message_id:row.id},'retry').catch(()=>{})} />
              {row.role==='assistant'&&row.status==='completed'&&<ClarificationForm row={row} account={account} conversation={conversationId}
                active={!streaming&&latestAssistantId===row.id} delivery={delivery} />}
              {!position&&!streaming&&canDraftFrom(row,latestAssistantId,questionRow?.id)&&<DraftFromDiscussion delivery={delivery} disabled={streaming} />}
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
        <CandidateHistory conversationId={conversationId} latest={latest.data} refresh={() => latest.refetch({ throwOnError: true })} />
        </div>
      </div>
      <AnimatePresence>
        {away && <motion.div className="ice-jump-latest" initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0 } : undefined}>
          <Button size="sm" onClick={jumpToLatest}>↓ {unread ? `${unread} 条回复有更新 · 回到最新` : "回到最新"}</Button>
        </motion.div>}
      </AnimatePresence>
      </div>
      {/* 行动岛：待确认的动作卡与输入框合为一块，从对话流中抬起。 */}
      <div className="ice-action-dock">
        <AgentActionCards conversationId={conversationId} refreshSignal={toolSeq} />
        {questionRow && <QuestionDock row={questionRow} account={account} conversation={conversationId}
          delivery={delivery} disabled={streaming} />}
        <Composer key={account + ":" + conversationId} conversationId={conversationId} streaming={streaming} reuse={reuse} delivery={delivery} />
      </div>
    </div>
  );
}
