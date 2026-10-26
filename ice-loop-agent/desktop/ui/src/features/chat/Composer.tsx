import * as React from "react";
import { motion } from "motion/react";
import { Button } from "../../components/ui";
import { DeliveryNotice } from "./DeliveryNotice";
import type {ChatDelivery} from "./useChatDelivery";
import { toast } from "../../components/toast";
import { citationStore, rpc, useCitations, useCurrentAccount } from "../../data/client";
import { appendComposerText, composerKey, loadComposerDraft, saveComposerDraft, shouldSendKey,
  peekStagedComposerDraft, acknowledgeStagedComposerDraft, type ComposerMode } from "../../data/composerDraft";

const MODES = [
  { value: "discuss", label: "讨论" },
  { value: "draft", label: "初稿" },
  { value: "edit", label: "改稿" },
  { value: "images", label: "配图" },
] as const;

export function Composer({ conversationId, streaming, reuse, delivery }: { conversationId: string; streaming: boolean; reuse: { id: number; text: string } | null; delivery:ChatDelivery }) {
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
  const draftEditId=React.useRef(initial.editId??crypto.randomUUID());
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const updateText = (value: string) => { draftEditId.current=crypto.randomUUID(); setRestored(false); setText(value); };
  React.useEffect(() => {
    let ok = false;
    try {
      ok = saveComposerDraft(window.localStorage, account, conversationId, { text, mode,editId:draftEditId.current });
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
    draftEditId.current=crypto.randomUUID(); setRestored(false); setText(current => appendComposerText(current, reuse.text));
    inputRef.current?.focus();
  }, [reuse]);
  const composing = React.useRef(false);
  const citations = useCitations();
  const [stopping, setStopping] = React.useState(false);
  const overLimit = text.trim().length > 12000;

  const stopLock=React.useRef(false);
  React.useEffect(()=>{
    const settled=delivery.settlement;
    if(settled?.result.accepted&&settled.record.source==='composer'&&settled.record.draftEditId===draftEditId.current){
      draftEditId.current=crypto.randomUUID();setText('');setRestored(false);
    }
  },[delivery.settlement]);
  const submit = () => {
    const trimmed=text.trim();
    if(!trimmed||overLimit||delivery.busy||delivery.pending||streaming)return;
    try{setPersisted(saveComposerDraft(window.localStorage,account,conversationId,{text,mode,editId:draftEditId.current}));}catch{setPersisted(false);}
    void delivery.send({text:trimmed,mode,citations:citations.map(citation=>({chunk_id:citation.chunkId,hash:citation.hash}))},'composer',draftEditId.current)
      .catch(()=>{});
  };

  return (
    <div className="ice-composer">
      <DeliveryNotice delivery={delivery} />
      <div className="ice-composer__modes" role="group" aria-label="创作模式">
        {MODES.map(option => <button key={option.value} type="button" aria-pressed={mode === option.value}
          onClick={() => { draftEditId.current=crypto.randomUUID(); setMode(option.value); }}>
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
      <textarea
        ref={inputRef}
        aria-label="消息输入"
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
        aria-invalid={overLimit || undefined}
        aria-describedby="ice-composer-help"
      />
      <div className="ice-composer__footer">
        <span id="ice-composer-help" className={"ice-composer-note" + (!persisted || overLimit ? " ice-error-text" : "")}>
          {overLimit ? "消息超过 12000 字符，请分段发送" : !persisted ? "本地保存失败，请保留此窗口或复制输入" : restored ? "已恢复上次未发送内容" : "Enter 发送 · Shift+Enter 换行"}
          {text.length > 0 && <span> · {text.length} 字符</span>}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="primary" loading={delivery.busy}
                disabled={streaming || delivery.busy || Boolean(delivery.pending) || overLimit || !text.trim()}
                onClick={submit}>发送</Button>
        {(streaming && !delivery.pending) && (
          <Button variant="secondary" loading={stopping} onClick={async () => {
            if(stopLock.current)return;stopLock.current=true;setStopping(true);
            try { await rpc("chat.stop", { account_id:account,conversation_id: conversationId }); toast.info("已请求停止，正在等待引擎结束当前步骤"); }
            catch (error) { toast.error({ title:"停止失败", detail:(error as Error).message }); }
            finally { stopLock.current=false;setStopping(false); }
          }}>停止</Button>
        )}
      </div>
    </div>
  );
}
