// v3.22 同步到公众号草稿箱：用公众号接口把冻结的交付版本写进草稿箱（不发布）。
// AppSecret 经桌面主进程的系统凭据加密保存，界面只知道“已保存/未保存”。
import * as React from "react";

import { Banner, Button, Dialog, Input } from "../../components/ui";
import { toast } from "../../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery, useCurrentAccount } from "../../data/client";
import { formatTime } from "./documentsApi";

// v3.25 从编辑器打开所在的多图文：对话框按需加载（它也引用本文件的接口设置对话框）
const WeChatGroupDialog = React.lazy(() => import("./WeChatGroupDialog").then(module => ({ default: module.WeChatGroupDialog })));

type Status = { configured: boolean; appid: string; secret_set: boolean; last_check_at: string | null; last_check_ok: boolean | null;
  last_check_message: string; draft?: { media_id: string; version_id: string; synced_at: string } | null;
  unknown_operation?: { op_id: string; action: string; created_at: string } | null;
  groups?: { group_key: string; media_id: string; synced_at: string; position: number; document_ids: string[]; current: boolean;
    members: { document_id: string; title: string; available: boolean }[] }[] };
type SyncResult = { media_id?: string; action?: "created" | "updated" | "recreated"; version_id?: string; uploaded?: number; reused?: number;
  warnings?: string[]; note?: string; conflict?: boolean; needs_check?: boolean; message?: string; synced_at?: string };

export type WeChatStatus = Status;

const ACTION = { created: "已新建草稿", updated: "已更新草稿", recreated: "已重新建草稿" } as const;

function useAlive() {
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

/** 公众号接口设置：AppID、AppSecret（加密保存）与连接测试。 */
export function WeChatConfigDialog({ open, onClose, status }: { open: boolean; onClose: () => void; status?: Status }) {
  const account = useCurrentAccount();
  const [appid, setAppid] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  React.useEffect(() => { if (open) { setAppid(status?.appid ?? ""); setSecret(""); setResult(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true); setResult(null);
    try {
      await rpc("wechat.configure", { account_id: account, appid: appid.trim() });
      if (secret) {
        if (!window.ice?.saveKey) throw new Error("当前环境不能保存密钥，请在桌面应用里设置");
        await window.ice.saveKey("wechat-" + account, secret);
        setSecret("");
      }
      const tested = await rpc<Status & { ok: boolean; message: string }>("wechat.test", { account_id: account });
      setResult({ ok: tested.ok, message: tested.message });
      void queryClient.invalidateQueries({ queryKey: ["ice", account, "wechat.status"] });
    } catch (error) { setResult({ ok: false, message: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }} title="公众号接口" width={520}
      description="用于把文章同步到这个公众号的草稿箱。只用草稿相关接口，不会发布或群发。"
      footer={<><Button onClick={onClose} disabled={busy}>关闭</Button>
        <Button variant="primary" loading={busy} disabled={!/^wx[0-9A-Za-z]{16}$/.test(appid.trim()) || (!status?.secret_set && !secret)}
                onClick={() => void save()}>保存并测试连接</Button></>}>
      <div className="ice-doc-form">
        <label>AppID（开发者 ID）<Input value={appid} maxLength={18} placeholder="wx 开头的 18 位" onChange={event => setAppid(event.target.value)} /></label>
        <label>AppSecret（开发者密码）
          <Input type="password" value={secret} maxLength={64} autoComplete="off"
                 placeholder={status?.secret_set ? "已保存；留空表示不修改" : "在公众号后台获取"} onChange={event => setSecret(event.target.value)} /></label>
        <p className="ice-doc-muted">在公众号后台“设置与开发 → 基本配置”获取开发者 ID 和密码，并把本机的出口 IP 加入“IP 白名单”（测试连接失败时会显示需要添加的 IP）。密钥用系统凭据加密保存在本机，只对当前公众号有效。</p>
        {result && <Banner tone={result.ok ? "success" : "warning"} title={result.ok ? "连接正常" : "连接没有成功"}>{result.message}</Banner>}
        {!result && status?.last_check_at && <p className="ice-doc-muted">上次测试：{formatTime(status.last_check_at)} · {status.last_check_message}</p>}
      </div>
    </Dialog>
  );
}

/** 交付面板里的“同步到草稿箱”。versionId 为当前预览的冻结版本。 */
export function WeChatDraftPanel({ documentId, versionId, title, complete, onSynced }: {
  documentId: string; versionId: string; title: string; complete: boolean; onSynced: (versionId: string) => void;
}) {
  const alive = useAlive();
  const status = useAccountQuery<Status>("wechat.status", { document_id: documentId }, { staleTime: 0, retry: false });
  const [config, setConfig] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<SyncResult | null>(null);
  const [group, setGroup] = React.useState<string[] | null>(null);
  const ready = Boolean(status.data?.configured && status.data.secret_set);
  const sync = async (extra: Record<string, unknown> = {}) => {
    const owner = accountStore.get(), here = () => alive.current && accountStore.get() === owner;
    setBusy(true); setPending(null);
    try {
      const result = await rpc<SyncResult>("wechat.draft_sync", { account_id: owner, document_id: documentId, version_id: versionId, ...extra });
      void queryClient.invalidateQueries({ queryKey: ["ice", owner, "wechat.status"] });
      if (result.conflict || result.needs_check) { if (here()) setPending(result); return; }
      if (!here()) { toast.info({ title: `「${title}」已同步到草稿箱`, detail: "同步在离开前已开始，属于原公众号。" }); return; }
      onSynced(result.version_id ?? versionId);
      toast.success({ title: ACTION[result.action ?? "created"], detail: [result.note, ...(result.warnings ?? [])].filter(Boolean).join("；") });
    } catch (error) { if (here()) toast.error({ title: "没有同步到草稿箱", detail: (error as Error).message }); }
    finally { if (alive.current) setBusy(false); }
  };
  const draft = status.data?.draft;
  return (
    <section className="ice-doc-wechat" aria-label="同步到公众号草稿箱">
      <div className="ice-doc-row">
        <strong>公众号草稿箱</strong>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => setConfig(true)}>{ready ? "接口设置" : "设置公众号接口"}</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!ready || !complete || Boolean(pending)}
                title={!ready ? "先设置公众号接口" : !complete ? "先处理上面的阻断问题" : "把这个版本写进公众号草稿箱（不发布）"}
                onClick={() => void sync()}>同步到草稿箱</Button>
      </div>
      {status.error && <p className="ice-doc-muted">接口状态读取失败：{status.error.message}</p>}
      {!ready && !status.error && <p className="ice-doc-muted">设置 AppID 与 AppSecret 后，可以把文章（正文、图片、封面、作者、摘要）直接写进草稿箱，再到后台预览和发布。</p>}
      {draft && <p className="ice-doc-muted">已同步 {formatTime(draft.synced_at)} · 草稿 …{draft.media_id.slice(-6)}
        {draft.version_id !== versionId ? " · 当前版本还没有同步" : " · 与当前版本一致"}</p>}
      {(status.data?.groups ?? []).length > 0 && <ul className="ice-wxgroups" aria-label="所在的多图文草稿">
        {(status.data?.groups ?? []).map(item => {
          const others = item.members.filter(member => member.document_id !== documentId)
            .map(member => `《${member.title}》${member.available ? "" : "（已移入回收站）"}`).join("");
          return <li key={item.group_key}>
            <span className="ice-wxgroups__main">
              <strong>多图文 · 第 {item.position} 篇 / 共 {item.members.length} 篇</strong>
              <span className="ice-doc-muted ice-wxgroups__titles" title={others}>同组：{others}</span>
              <span className="ice-doc-muted">{formatTime(item.synced_at)} 同步 · <span className={item.current ? "is-ok" : "is-stale"}>
                {item.current ? "已是这篇的最新版本" : "这篇有新版本未同步"}</span></span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setGroup(item.document_ids)}>打开这组</Button>
          </li>;
        })}
      </ul>}
      {pending?.needs_check && <Banner tone="warning" title="上次同步结果未知">{pending.message}
        <div className="ice-doc-row"><Button size="sm" onClick={() => void sync({ checked_unknown: true })}>我已核对，继续同步</Button>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>稍后</Button></div></Banner>}
      {pending?.conflict && <Banner tone="warning" title="后台草稿被修改过">{pending.message}
        <div className="ice-doc-row"><Button size="sm" onClick={() => void sync({ mode: "new" })}>另建一篇草稿</Button>
          <Button size="sm" variant="ghost" className="ice-doc-danger-text" onClick={() => void sync({ mode: "overwrite" })}>用当前版本覆盖</Button>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>取消</Button></div></Banner>}
      <WeChatConfigDialog open={config} onClose={() => setConfig(false)} status={status.data} />
      {group && <React.Suspense fallback={null}>
        <WeChatGroupDialog open documentIds={group} onClose={() => setGroup(null)} onDone={() => setGroup(null)} />
      </React.Suspense>}
    </section>
  );
}
