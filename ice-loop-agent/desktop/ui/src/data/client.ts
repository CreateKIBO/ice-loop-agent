// 账号隔离异步数据层（M2-05）。
// 铁律：所有 query key 以 ['ice', accountId, ...] 开头；切换账号时整体清缓存，
// 防止任何对象（消息/候选/任务/资源）跨公众号串显。
import { QueryClient, useQuery, useMutation, type UseQueryOptions } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { advanceCursor, boundStreamEvents, mergeEvents, needsBackfill, type StreamEvent } from "./eventStream";
import { ResourceCache } from "./resourceCache";
import { chatResult, jobRows } from "./workbenchResponses";
import { createDirtyFlusher } from "./dirtyFlush";
import { documentStore } from "../app/uiState";

export interface IceBridge {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

function bridge(): IceBridge {
  const candidate = (window as unknown as { ice?: IceBridge }).ice;
  if (!candidate) throw new Error("桌面桥接未加载（应通过 ICE Loop Studio 打开）");
  return candidate;
}

// ---------------------------------------------------------------- 账号状态
let currentAccount = "";
const accountListeners = new Set<() => void>();

export const accountStore = {
  get: () => currentAccount,
  set(next: string) {
    if (next === currentAccount) return;
    currentAccount = next;
    accountListeners.forEach(listener => listener());
  },
  subscribe(listener: () => void) {
    accountListeners.add(listener);
    return () => { accountListeners.delete(listener); };
  },
};

export function useCurrentAccount(): string {
  return useSyncExternalStore(accountStore.subscribe, accountStore.get);
}

// ---------------------------------------------------------------- 会话选择
let currentConversation: string | null = null;
const conversationListeners = new Set<() => void>();

export const conversationStore = {
  get: () => currentConversation,
  set(next: string | null) {
    if (next === currentConversation) return;
    currentConversation = next;
    conversationListeners.forEach(listener => listener());
    try {
      if (next) window.localStorage.setItem("ice.ui.conversation", next);
      else window.localStorage.removeItem("ice.ui.conversation");
    } catch { /* 持久化失败不影响当前会话 */ }
  },
  subscribe(listener: () => void) {
    conversationListeners.add(listener);
    return () => { conversationListeners.delete(listener); };
  },
};

export function useCurrentConversation(): string | null {
  return useSyncExternalStore(conversationStore.subscribe, conversationStore.get);
}

// ---------------------------------------------------------------- 编辑对象选择
let currentEditorJob: string | null = null;
const editorListeners = new Set<() => void>();

export const editorStore = {
  get: () => currentEditorJob,
  set(next: string | null) {
    if (next === currentEditorJob) return;
    currentEditorJob = next;
    editorListeners.forEach(listener => listener());
  },
  subscribe(listener: () => void) {
    editorListeners.add(listener);
    return () => { editorListeners.delete(listener); };
  },
};

export function useEditorJob(): string | null {
  return useSyncExternalStore(editorStore.subscribe, editorStore.get);
}

// ------------------------------------------------------- 对象级 dirty（M2-06）
// 每个对象一个键（如 job:{id}:editor）；不用全局布尔，互不覆盖。
type DirtyEntry = { dirty: boolean };
const dirtyMap = new Map<string, DirtyEntry>();
const dirtyListeners = new Set<() => void>();
let dirtyVersion = 0;

function notifyDirty() {
  dirtyVersion += 1;
  dirtyListeners.forEach(listener => listener());
}

export const dirtyStore = {
  isDirty: (key: string) => dirtyMap.get(key)?.dirty ?? false,
  anyDirty: () => [...dirtyMap.values()].some(entry => entry.dirty),
  markDirty(key: string) {
    const previous = dirtyMap.get(key);
    if (previous?.dirty) return;
    dirtyMap.set(key, { dirty: true });
    notifyDirty();
  },
  markClean(key: string) {
    if (!dirtyMap.get(key)?.dirty) return;
    dirtyMap.delete(key);
    notifyDirty();
  },
  subscribe(listener: () => void) {
    dirtyListeners.add(listener);
    return () => { dirtyListeners.delete(listener); };
  },
  get version() { return dirtyVersion; },
};

// ------------------------------------------------- 导航前即时落盘（R04 批次二）
// debounce 窗口内的修改在切文章/会话/账号前立即保存工作草稿，不等 800ms。
export const { registerDirtyFlush, flushAllDirty, lastFlushFailure } =
  createDirtyFlusher(key => dirtyMap.get(key)?.dirty ?? false);

export function useObjectDirty(key: string): boolean {
  return useSyncExternalStore(dirtyStore.subscribe, () => dirtyStore.isDirty(key));
}

export function useAnyDirtyGuard(): void {
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyStore.anyDirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}

// ------------------------------------------------------- 手选引文（M4-05）
// 引用只在客户端选择；送入 ContextPack 时由后端按 chunk_id 做 hash 绑定。
type Citation = { chunkId: string; displayName: string; section: string; hash: string };
let citations: Citation[] = [];
const citationListeners = new Set<() => void>();

function notifyCitations() {
  citations = [...citations];
  citationListeners.forEach(listener => listener());
}

export const citationStore = {
  get: () => citations,
  add(entry: Citation) {
    if (citations.some(item => item.chunkId === entry.chunkId)) return;
    if (citations.length >= 8) return; // 与后端 ContextPack 上限一致
    citations.push(entry);
    notifyCitations();
  },
  remove(chunkId: string) {
    citations = citations.filter(item => item.chunkId !== chunkId);
    notifyCitations();
  },
  clear() {
    citations = [];
    notifyCitations();
  },
  subscribe(listener: () => void) {
    citationListeners.add(listener);
    return () => { citationListeners.delete(listener); };
  },
};

export function useCitations(): Citation[] {
  return useSyncExternalStore(citationStore.subscribe, citationStore.get);
}

// ---------------------------------------------------------------- Query 客户端
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 桌面本地 IPC：失败立刻可见；不无限退避。
      retry: false,
      staleTime: 5_000,
      gcTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** 切换账号：清空全部缓存（不是按前缀过滤——宁可重取，不可串账号）。 */
export function resetForAccountSwitch(nextAccount: string) {
  queryClient.cancelQueries();
  queryClient.clear();
  citationStore.clear();
  streamCache.clear();
  editorStore.set(null);
  conversationStore.set(null);
  documentStore.set(null);
  accountStore.set(nextAccount);
}

type RpcErrorShape = { code?: string; recoverable?: boolean; action?: string | null };

export class RpcError extends Error {
  constructor(readonly code: string, message: string,
              readonly recoverable: boolean, readonly action?: string | null) {
    super(message);
    this.name = "RpcError";
  }
}

/** main.cjs 将引擎错误以 Error(code/recoverable/action) reject；这里统一成 RpcError。 */
export async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  try {
    const value = await bridge().request(method, params);
    if (method === "chat.get" || method === "chat.create") return chatResult(value) as T;
    if (method === "jobs.list") return jobRows(value) as T;
    return value as T;
  } catch (error) {
    const shape = error as RpcErrorShape;
    if (shape && typeof shape === "object" && shape.code) {
      throw new RpcError(shape.code, (error as Error).message,
                         Boolean(shape.recoverable), shape.action ?? null);
    }
    throw error;
  }
}

/** 账号域查询：key 自动带上当前账号；账号为空时不发请求。 */
export function useAccountQuery<T>(method: string, params?: Record<string, unknown>,
                                   options?: Partial<UseQueryOptions<T, RpcError>>) {
  const account = useCurrentAccount();
  const key = ["ice", account, method, params ?? {}] as const;
  return useQuery<T, RpcError>({
    ...options,
    queryKey: key,
    queryFn: () => rpc<T>(method, { account_id: account, ...params }),
    // 放在 ...options 之后：调用方传 enabled 时不能绕过"账号为空不发请求"。
    enabled: Boolean(account) && (options?.enabled ?? true),
  });
}

/** 账号域变更：成功后可按前缀失效。 */
export function useAccountMutation<TVars, TData = unknown>(
  method: string,
  opts?: { invalidate?: string[][]; transform?: (vars: TVars) => Record<string, unknown> },
) {
  const account = useCurrentAccount();
  return useMutation<TData, RpcError, TVars>({
    mutationFn: (vars: TVars) => {
      const params = opts?.transform ? opts.transform(vars) : (vars as unknown as Record<string, unknown>);
      return rpc<TData>(method, { account_id: account, ...params });
    },
    onSuccess: () => {
      for (const prefix of opts?.invalidate ?? []) {
        queryClient.invalidateQueries({ queryKey: ["ice", account, ...prefix] });
      }
    },
  });
}

// ------------------------------------------------- 引擎事件流（M1-05 / C1）
// 游标与已收事件按"账号|流"缓存在模块级：切换会话再回来不重复拉取，也不会串账号。
type StreamCache = { cursor: number; events: StreamEvent[] };
const streamCache = new ResourceCache<StreamCache>(20, 5 * 1024 * 1024, 15 * 60 * 1000,
  value => JSON.stringify(value).length * 2);
const EVENT_POLL_MS = 500;
const EVENT_FINAL_PASSES = [0, 700];
const EVENT_PAGES_PER_TICK = 5;

/** active 期间约每 500ms 按游标补取；转为非活跃时再补取两次（结束事件可能晚于状态提交）。 */
export function useEventStream(streamId: string | null, active: boolean): StreamEvent[] {
  const account = useCurrentAccount();
  const key = account && streamId ? account + "|" + streamId : "";
  const [state, setState] = useState<{ key: string; events: StreamEvent[] }>(
    () => ({ key, events: streamCache.get(key)?.events ?? [] }));
  const wasActive = useRef(false);
  useEffect(() => {
    if (!key) return;
    const finishing = !active && wasActive.current;
    wasActive.current = active;
    if (!active && !finishing) return;
    let stopped = false;
    let timer: number | undefined;
    let finalPass = 0;
    const pull = async () => {
      for (let page = 0; page < EVENT_PAGES_PER_TICK; page += 1) {
        const before = streamCache.get(key) ?? { cursor: 0, events: [] };
        const data = await rpc<{ events: StreamEvent[]; latest: number }>(
          "events.poll", { account_id: account, stream_id: streamId, after: before.cursor });
        if (stopped) return;
        const current = streamCache.get(key) ?? before;
        const next = { cursor: Math.max(current.cursor, advanceCursor(before.cursor, data.events)),
                       events: boundStreamEvents(mergeEvents(current.events, data.events)) };
        streamCache.set(key, next);
        setState(previous => previous.key === key && previous.events === next.events ? previous : { key, events: next.events });
        if (!data.events.length || !needsBackfill(next.cursor, data.latest)) return;
      }
    };
    const tick = async () => {
      try { await pull(); } catch { /* 断线时游标不前进，下一轮从原位置补取 */ }
      if (stopped) return;
      if (active) timer = window.setTimeout(tick, EVENT_POLL_MS);
      else if (++finalPass < EVENT_FINAL_PASSES.length) timer = window.setTimeout(tick, EVENT_FINAL_PASSES[finalPass]);
    };
    timer = window.setTimeout(tick, EVENT_FINAL_PASSES[0]);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [key, active, account, streamId]);
  if (!key) return [];
  return state.key === key ? state.events : streamCache.get(key)?.events ?? [];
}
