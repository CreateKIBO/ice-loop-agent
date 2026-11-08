// v3.13 作者试用记录：手动开始/结束；自动记下关键步骤的类型、时间与数量（不含正文）；作者可随时记一笔卡点；生成 Markdown 报告。
import * as React from "react";

import { Button, Dialog, Input } from "../../components/ui";
import { toast } from "../../components/toast";
import { queryClient, rpc, useAccountQuery, useCurrentAccount } from "../../data/client";
import { documentStore, trialDialogStore, workspaceStore } from "../../app/uiState";

type Session = { session_id: string; label: string; include_titles: number; started_at: string; ended_at: string | null; events?: number };
type Status = { active: Session | null; events: number; sessions: Session[] };

const time = (value: string | null) => value ? value.slice(5, 16).replace("T", " ") : "";

export function useTrialStatus() {
  return useAccountQuery<Status>("documents.trial_status", {}, { staleTime: 15_000, refetchInterval: 30_000 });
}

/** 左栏状态条：只在试用记录进行中显示。 */
export function TrialBar() {
  const status = useTrialStatus();
  if (!status.data?.active) return null;
  return (
    <div className="ice-trial-bar" role="status">
      <span className="ice-trial-bar__dot" aria-hidden />
      <button type="button" className="ice-trial-bar__main" onClick={() => trialDialogStore.set("open")}>作者试用记录中 · {status.data.events} 条</button>
      <button type="button" className="ice-link-btn" onClick={() => trialDialogStore.set("note")}>记卡点</button>
    </div>
  );
}

export function TrialDialog() {
  const account = useCurrentAccount();
  const mode = trialDialogStore.use();
  const status = useTrialStatus();
  const [label, setLabel] = React.useState("");
  const [titles, setTitles] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const noteRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => { if (mode === "note") window.setTimeout(() => noteRef.current?.focus(), 60); }, [mode]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.trial_status"] });
  const call = async <T,>(method: string, params: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try {
      const value = await rpc<T>(method, { account_id: account, ...params });
      void refresh();
      if (done) toast.success({ title: done });
      return value;
    } catch (error) { toast.error({ title: "没有完成", detail: (error as Error).message }); return null; }
    finally { setBusy(false); }
  };
  const copyReport = async (sessionId?: string) => {
    const report = await call<{ markdown: string }>("documents.trial_report", sessionId ? { session_id: sessionId } : {});
    if (!report) return;
    try {
      const bridge = window.ice?.copyText as undefined | ((text: string) => Promise<unknown>);
      if (typeof bridge === "function") await bridge(report.markdown); else await navigator.clipboard.writeText(report.markdown);
      toast.success({ title: "已复制试用报告", detail: "Markdown 格式；只含操作类型、时间、数量和作者记下的卡点。" });
    } catch (error) { toast.error({ title: "没有复制", detail: (error as Error).message }); }
  };
  const addNote = async () => {
    const where = workspaceStore.get() === "articles" ? (documentStore.get() ? "editor" : "home") : String(workspaceStore.get());
    const ok = await call("documents.trial_note", { text: note.trim(), where, document_id: documentStore.get() ?? undefined }, "已记下卡点");
    if (ok) { setNote(""); if (mode === "note") trialDialogStore.set("closed"); }
  };
  const active = status.data?.active ?? null;
  const past = (status.data?.sessions ?? []).filter(item => item.ended_at);
  return (
    <Dialog open={mode !== "closed"} onOpenChange={value => { if (!value) trialDialogStore.set("closed"); }} title="作者试用记录" width={560}
            description="用于邀请作者试用时，记录完成写作与交付花了多久、哪里卡住、AI 改稿后作者又改了多少。只存在本机，由你决定是否分享报告。"
            footer={<Button onClick={() => trialDialogStore.set("closed")}>关闭</Button>}>
      <div className="ice-doc-form ice-trial">
        {!active ? <>
          <ul className="ice-trial__facts">
            <li>开始后自动记录关键步骤：新建/粘贴/Word 导入、AI 起草、AI 局部修改的发起/采纳/放弃/撤销、保存版本、复制、导出、登记发布。</li>
            <li><strong>只记类型、时间和数量</strong>，例如“采纳 3/4 处”；不记正文、提示词或模型输出。</li>
            <li>试用中可以随时“记卡点”；结束后生成 Markdown 报告，包括用时、次数、采纳率和改稿比例。</li>
          </ul>
          <label className="ice-doc-field">试用名称（可选）
            <Input value={label} maxLength={60} placeholder="例如：作者 A · 第一次使用" aria-label="试用名称" onChange={event => setLabel(event.target.value)} /></label>
          <label className="ice-doc-check"><input type="checkbox" checked={titles} onChange={event => setTitles(event.target.checked)} />
            报告中包含文章标题（默认不含）</label>
          <div className="ice-doc-row"><span style={{ flex: 1 }} />
            <Button variant="primary" loading={busy} onClick={() => void call("documents.trial_start", { label: label.trim(), include_titles: titles }, "已开始试用记录")}>开始记录</Button></div>
        </> : <>
          <div className="ice-trial__status"><span className="ice-trial-bar__dot" aria-hidden />
            <strong>{active.label || "作者试用"}</strong><span className="ice-doc-muted">自 {time(active.started_at)} 起 · 已记 {status.data?.events ?? 0} 条</span></div>
          <label className="ice-doc-field">记一笔卡点（哪里看不懂、找不到、等太久、不得不绕路）
            <textarea ref={noteRef} className="ice-assist__input" rows={3} maxLength={500} value={note} aria-label="卡点说明"
                      placeholder="例如：想把图片换成另一张，找了一会儿才发现要选中图片" onChange={event => setNote(event.target.value)}
                      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && note.trim()) { event.preventDefault(); void addNote(); } }} /></label>
          <div className="ice-doc-row">
            <span className="ice-doc-muted">会附带当前位置（首页/编辑器/助手）。</span><span style={{ flex: 1 }} />
            <Button size="sm" disabled={!note.trim()} loading={busy} onClick={() => void addNote()}>记下</Button>
          </div>
          <div className="ice-doc-row">
            <Button size="sm" variant="ghost" onClick={() => void copyReport(active.session_id)}>复制当前报告</Button><span style={{ flex: 1 }} />
            <Button size="sm" loading={busy} onClick={() => void call("documents.trial_stop", {}, "试用记录已结束")}>结束记录</Button>
          </div>
        </>}
        {past.length > 0 && <details className="ice-trial__past">
          <summary>以往的试用（{past.length}）</summary>
          <ul>{past.map(item => <li key={item.session_id} className="ice-doc-row">
            <span>{item.label || "作者试用"} · {time(item.started_at)}–{time(item.ended_at)} · {item.events ?? 0} 条</span><span style={{ flex: 1 }} />
            <button type="button" className="ice-link-btn" onClick={() => void copyReport(item.session_id)}>复制报告</button></li>)}</ul>
        </details>}
      </div>
    </Dialog>
  );
}
