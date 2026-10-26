import * as React from "react";
import { Button, Dialog, Input } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { queryClient, rpc, useCurrentAccount } from "../../data/client";
import { refreshAfterWrite } from "../../data/receipts";
import { toast } from "../../components/toast";
import type { ChatResult } from '../../data/workbenchResponses';
import { useBootstrap } from "../../app/modelBootstrap";

export function ConversationHeader({ conversation, streaming, onFind, findOpen }: {
  conversation?: ChatResult['conversation']; streaming: boolean; onFind?: () => void; findOpen?: boolean;
}) {
  const account = useCurrentAccount();
  const boot=useBootstrap();
  const writer=boot.data?.settings?.profiles.find(profile=>profile.profile_id===boot.data?.settings?.routes?.writer?.primary);
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const [error, setError] = React.useState<unknown>(null);
  const selection=conversation?.target?.editorial_plan?.confirmation?.fields;
  const save = async () => {
    // 2026-10-20 交互验收：同 tick 三连点会绕过 useState 闭包的 busy 守卫发出多次写
    // （requests.jsonl 实测同毫秒 3 次 chat.update）。ref 与 state 双闸，同 tick 立即生效。
    if (!conversation || !title.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      await rpc("chat.update", { conversation_id: conversation.id, title: title.trim() });
      setOpen(false); toast.success("会话名称已更新");
      // 重命名已成功；标题列表刷新失败单独提示（批次A-04）。
      await refreshAfterWrite("会话重命名", () =>
        Promise.all(["chat.get", "chat.list"].map(method => queryClient.invalidateQueries({ queryKey:["ice",account,method] }, { throwOnError: true }))));
    } catch (err) { setError(err); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <>
    <header className="ice-conversation-header">
      <div className="ice-conversation-header__identity"><span className="ice-eyebrow">创作对话</span>
        <h1 title={conversation?.title}>{conversation?.title || "正在载入会话…"}</h1>
        {selection&&<span className="ice-composer-note">{selection.series} / {String(selection.episode).padStart(3,'0')} · 已确认期号{selection.title_mode==='ai'?' · 先讨论选题':'与本期标题'}</span>}
        {/* 批B2（2026-10-23）：当前模式/写作模型/文章关联的持续上下文；无关联如实显示。 */}
        <span className="ice-composer-note" title="来自「文字模型分工」的写作主模型；发送消息时实际使用">
          写作模型：{writer?`${writer.provider} · ${writer.model_id}`:'尚未读取'}
        </span>
        {!selection&&<span className="ice-composer-note">未关联期号——讨论不会自动创建文章或占用期号</span>}
      </div>
      <span className="ice-conversation-header__status"><span className={"ice-dot" + (streaming ? " ice-dot--ok" : "")} aria-hidden />{streaming ? "正在回复" : "已就绪"}</span>
      {onFind && (
        <Button size="sm" variant="ghost" disabled={!conversation}
                data-find-trigger aria-expanded={Boolean(findOpen)} aria-controls="ice-chat-find"
                title="在当前已加载内容内查找（非全历史检索）" onClick={onFind}>窗口内查找</Button>
      )}
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
        {error != null && <ErrorNote error={error} note="名称未修改。" />}
      </form>
    </Dialog>
  </>;
}
