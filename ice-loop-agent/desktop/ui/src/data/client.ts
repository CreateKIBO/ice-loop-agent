// 账号隔离异步数据层（M2-05）。
// 铁律：所有 query key 以 ['ice', accountId, ...] 开头；切换账号时整体清缓存，
// 防止任何对象（消息/候选/任务/资源）跨公众号串显。
import { QueryClient, useQuery, useMutation, type UseQueryOptions } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSyncExternalStore } from "react";

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
    return await bridge().request(method, params) as T;
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
    queryKey: key,
    queryFn: () => rpc<T>(method, { account_id: account, ...params }),
    enabled: Boolean(account) && (options?.enabled ?? true),
    ...options,
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

/** 引擎事件轮询（M1-05 游标拉取；新 UI 统一走这里，避免与旧页双订阅）。 */
export function useEventStream(streamId: string, onEvent: (event: { sequence: number; type: string; payload: unknown }) => void,
                               enabled = true) {
  const account = useCurrentAccount();
  useEffect(() => {
    if (!enabled || !account || !streamId) return;
    let cursor = 0;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const data = await rpc<{ events: Array<{ sequence: number; type: string; payload: unknown }>; latest: number }>(
          "events.poll", { account_id: account, stream_id: streamId, after: cursor });
        if (stopped) return;
        for (const event of data.events) {
          if (event.sequence > cursor) cursor = event.sequence;
          onEvent(event);
        }
        cursor = Math.max(cursor, data.latest);
      } catch { /* 断线下一轮补取；cursor 不回退即不重复应用 */ }
      if (!stopped) timer = window.setTimeout(tick, 600);
    };
    timer = window.setTimeout(tick, 0);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [streamId, account, enabled]);
}
