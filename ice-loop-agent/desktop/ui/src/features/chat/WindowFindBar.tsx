// Search only the bounded displayed window; keep selection by message identity.
import * as React from "react";
import { Button, Input } from "../../components/ui";
import type { ChatMessage } from "../../data/workbenchResponses";

export function WindowFindBar({ rows, onLocate, onHighlight, onClose }: {
  rows: ChatMessage[];
  onLocate: (messageId: string) => void;
  onHighlight: (messageId: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const callbacks = React.useRef({ onLocate, onHighlight });
  callbacks.current = { onLocate, onHighlight };
  const needle = query.trim().toLowerCase();
  const hits = React.useMemo(() => needle
    ? rows.filter(row => row.content.toLowerCase().includes(needle)).map(row => row.id) : [], [rows, needle]);
  const activeIndex = Math.max(0, selected === null ? -1 : hits.indexOf(selected));
  const activeId = hits[activeIndex] ?? null;

  React.useEffect(() => {
    inputRef.current?.focus();
    return () => callbacks.current.onHighlight(null);
  }, []);
  React.useEffect(() => {
    callbacks.current.onHighlight(activeId);
    if (activeId) callbacks.current.onLocate(activeId);
  }, [needle, activeId]);

  const go = (delta: number) => {
    if (!hits.length) return;
    const id = hits[(activeIndex + delta + hits.length) % hits.length];
    setSelected(id);
    if (id === activeId) callbacks.current.onLocate(id);
  };
  return <div id="ice-chat-find" role="search" aria-label="在当前阅读窗口查找" className="ice-window-find"
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <Input ref={inputRef} value={query} placeholder="在当前已加载内容内查找…" aria-label="查找内容"
      onChange={event => { setQuery(event.target.value); setSelected(null); }}
      onKeyDown={event => {
        if (!event.nativeEvent.isComposing && event.key === "Enter") {
          event.preventDefault(); go(event.shiftKey ? -1 : 1);
        }
      }} />
    <span role="status" aria-live="polite">{needle ? hits.length ? `${activeIndex + 1}/${hits.length} 条消息` : "无命中" : `本窗口 ${rows.length} 条`}</span>
    <Button size="sm" variant="ghost" disabled={!hits.length} onClick={() => go(-1)}>上一处</Button>
    <Button size="sm" variant="ghost" disabled={!hits.length} onClick={() => go(1)}>下一处</Button>
    <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSelected(null); inputRef.current?.focus(); }}>清除</Button>
    <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
  </div>;
}
