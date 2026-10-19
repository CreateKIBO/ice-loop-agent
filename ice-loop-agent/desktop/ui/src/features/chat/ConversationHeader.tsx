import * as React from "react";
import { Button, Dialog, Input } from "../../components/ui";
import { queryClient, rpc, useCurrentAccount, type RpcError } from "../../data/client";
import { toast } from "../../components/toast";
import type { ChatResult } from '../../data/workbenchResponses';

export function ConversationHeader({ conversation, streaming }: {
  conversation?: ChatResult['conversation']; streaming: boolean;
}) {
  const account = useCurrentAccount();
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const selection=conversation?.target?.editorial_plan?.confirmation?.fields;
  const save = async () => {
    if (!conversation || !title.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await rpc("chat.update", { conversation_id: conversation.id, title: title.trim() });
      await Promise.all(["chat.get", "chat.list"].map(method => queryClient.invalidateQueries({ queryKey:["ice",account,method] })));
      setOpen(false); toast.success("会话名称已更新");
    } catch (err) { setError((err as RpcError).message); }
    finally { setBusy(false); }
  };
  return <>
    <header className="ice-conversation-header">
      <div className="ice-conversation-header__identity"><span className="ice-eyebrow">创作对话</span>
        <h1 title={conversation?.title}>{conversation?.title || "正在载入会话…"}</h1>
        {selection&&<span className="ice-composer-note">{selection.series} / {String(selection.episode).padStart(3,'0')} · 已确认期号{selection.title_mode==='ai'?' · 先讨论选题':'与本期标题'}</span>}
      </div>
      <span className="ice-conversation-header__status"><span className={"ice-dot" + (streaming ? " ice-dot--ok" : "")} aria-hidden />{streaming ? "正在回复" : "已就绪"}</span>
      <Button size="sm" variant="ghost" disabled={!conversation || streaming} onClick={() => {
        setTitle(conversation?.title ?? ""); setError(null); setOpen(true);
      }}>重命名</Button>
    </header>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }} title="重命名会话"
      description="只修改会话名称，文章标题和正文保持原样。" initialFocus="input"
      footer={<><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button>
        <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void save()}>保存名称</Button></>}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="ice-sr-only" htmlFor="ice-conversation-title">会话名称</label>
        <Input id="ice-conversation-title" value={title} maxLength={120} disabled={busy}
          onChange={event => setTitle(event.target.value)} style={{width:"100%"}} />
        <p className="ice-composer-note">{title.length} / 120 字符</p>
        {error && <p role="alert" className="ice-error-text">{error}</p>}
      </form>
    </Dialog>
  </>;
}
