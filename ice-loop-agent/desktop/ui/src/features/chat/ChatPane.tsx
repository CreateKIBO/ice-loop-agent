// 中栏对话面板（M2-07/M2-09 基础）：消息时间线 + 输入框。
// IME 纪律：composition（中文输入法组词）期间 Enter 不发送；不重建输入根。
import * as React from "react";

import { Button, ErrorPanel, Spinner } from "../../components/ui";
import { useAccountMutation, useAccountQuery, type RpcError } from "../../data/client";

type ChatMessage = {
  id: string; role: string; content: string; status: string;
  metadata?: { progress?: string };
};

const MODES = [
  { value: "discuss", label: "讨论" },
  { value: "draft", label: "初稿" },
  { value: "edit", label: "改稿" },
  { value: "images", label: "配图" },
] as const;

export function ChatPane({ conversationId }: { conversationId: string | null }) {
  const messages = useAccountQuery<ChatMessage[]>("chat.get",
    conversationId ? { conversation_id: conversationId } : undefined,
    { enabled: Boolean(conversationId), refetchInterval: 1_500 });

  if (!conversationId) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--ice-text-secondary)" }}>
        从左侧选择会话，或新建一次讨论。
      </div>
    );
  }
  if (messages.error) {
    return <div style={{ padding: "var(--ice-space-4)" }}>
      <ErrorPanel title="会话加载失败" detail={(messages.error as RpcError).message}
                  onRetry={() => messages.refetch()} />
    </div>;
  }

  const rows = messages.data ?? [];
  const streaming = rows.some(row => row.status === "streaming");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--ice-space-4)", display: "grid",
                    gap: "var(--ice-space-3)", alignContent: "start" }}>
        {rows.map(row => <MessageBubble key={row.id} row={row} />)}
        {streaming && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ice-text-secondary)" }}>
            <Spinner size={12} /> 生成中…
          </div>
        )}
      </div>
      <Composer conversationId={conversationId} streaming={streaming} />
    </div>
  );
}

function MessageBubble({ row }: { row: ChatMessage }) {
  const isUser = row.role === "user";
  return (
    <div style={{ display: "grid", gap: 4, justifyItems: isUser ? "end" : "start" }}>
      <div style={{
        maxWidth: "min(640px, 92%)", padding: "var(--ice-space-2) var(--ice-space-3)",
        borderRadius: "var(--ice-radius-lg)", whiteSpace: "pre-wrap",
        background: isUser ? "var(--ice-info-bg)" : "var(--ice-surface)",
        border: `1px solid ${isUser ? "transparent" : "var(--ice-border)"}`,
      }}>{row.content}</div>
    </div>
  );
}

function Composer({ conversationId, streaming }: { conversationId: string; streaming: boolean }) {
  const [text, setText] = React.useState("");
  const [mode, setMode] = React.useState<(typeof MODES)[number]["value"]>("discuss");
  const composing = React.useRef(false);

  const send = useAccountMutation<{ text: string; mode: string }>("chat.send", {
    transform: vars => ({ conversation_id: conversationId, text: vars.text, mode: vars.mode }),
  });

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending) return;
    send.mutate({ text: trimmed, mode }, {
      onSuccess: () => setText(""),
      // 失败保留输入（对象级 dirty 原则：网络失败不清空用户输入）。
    });
  };

  return (
    <div style={{ borderTop: "1px solid var(--ice-border)", padding: "var(--ice-space-3)",
                  display: "grid", gap: "var(--ice-space-2)", background: "var(--ice-surface)" }}>
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
        placeholder={streaming ? "上一条回复仍在生成…" : "输入消息，Enter 发送，Shift+Enter 换行"}
        disabled={streaming}
        rows={3}
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
        <Button variant="primary" loading={send.isPending} disabled={streaming && !send.isPending}
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
