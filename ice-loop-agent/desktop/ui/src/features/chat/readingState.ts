export const isNearBottom = (height: number, top: number, viewport: number, threshold = 80) =>
  height - Math.max(0, top) - viewport <= threshold;

// Query options survive the observer for gcTime. Keep this callback outside the
// component so an inactive query cannot retain a whole rendered event timeline.
export function idleChatPollingInterval(query: { state: { data?: { messages: Array<{ status: string }> } } }): number {
  return query.state.data?.messages.some(row => row.status === 'streaming') ? 1500 : 8000;
}

/** Track content growth as well as new messages; streaming text can grow in place. */
export function unreadAssistantUpdates(rows: Array<{ id: string; role: string; content: string }>, seen: ReadonlyMap<string, string>): number {
  return rows.filter(row => row.role === "assistant" && row.content && seen.get(row.id) !== row.content).length;
}

export function safeMessageUrl(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
