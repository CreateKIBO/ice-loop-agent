export type ChatMessage = {
  id: string; role: string; content: string; status: string;
  // 引擎写入的是 {phase, started_at, transitions, ...} 对象，不能直接渲染。
  metadata?: { progress?: unknown; [key: string]: unknown };
};

export type ChatResult = {
  conversation: { id: string; title: string; target?:{editorial_plan?:{confirmation?:{fields:{series:string;episode:number;topic:string;title_mode:string}}}} };
  messages: ChatMessage[];
  candidates: unknown[];
  current: unknown;
  message_page?: ChatPage;
  candidate_page?: ChatPage;
};

export type ChatPage = {
  has_older: boolean; has_newer: boolean;
  oldest_id: string | null; newest_id: string | null;
};

/** Validate the response boundary before handing it to React. */
export function chatResult(value: unknown): ChatResult {
  if (!value || typeof value !== "object") throw new Error("会话响应格式无效，请重试或升级引擎");
  const row = value as Record<string, unknown>;
  const conversation = row.conversation as Record<string, unknown> | null;
  if (!conversation || typeof conversation.id !== "string" || typeof conversation.title !== "string"
      || !Array.isArray(row.messages) || !Array.isArray(row.candidates)
      || !row.messages.every(message => message && typeof message === "object"
        && typeof message.id === "string" && typeof message.role === "string"
        && typeof message.content === "string" && typeof message.status === "string")) {
    throw new Error("会话响应格式无效，请重试或升级引擎");
  }
  for (const key of ['message_page', 'candidate_page']) {
    if (row[key] === undefined) continue;
    const page = row[key] as ChatPage | null;
    if (!page || typeof page.has_older !== 'boolean' || typeof page.has_newer !== 'boolean'
        || !['oldest_id', 'newest_id'].every(id => page[id as keyof ChatPage] === null || typeof page[id as keyof ChatPage] === 'string')) {
      throw new Error('历史分页响应无效，请重试或升级引擎');
    }
  }
  return value as ChatResult;
}

export function jobRows(value: unknown): Array<{ job_id: string }> {
  if (!Array.isArray(value) || !value.every(row => row && typeof row.job_id === "string")) {
    throw new Error("任务列表响应格式无效，请重试或升级引擎");
  }
  return value;
}
