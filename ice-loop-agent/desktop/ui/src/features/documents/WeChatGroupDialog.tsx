// v3.24 多图文草稿：把选中的 2–8 篇文章按顺序合成一篇草稿（第一篇为头条）。只写草稿箱，不发布。
// 每篇用最近的稳定版本；接口不能调整已有草稿的篇目和顺序，所以顺序或篇目变了就是另一篇草稿。
import * as React from "react";

import { Banner, Button, Dialog } from "../../components/ui";
import { toast } from "../../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery } from "../../data/client";
import { formatTime, invalidateDocuments } from "./documentsApi";
import { WeChatConfigDialog, type WeChatStatus } from "./WeChatDraftPanel";

type Item = { document_id: string; title: string; version_id: string | null; version_created_at: string | null; unversioned: boolean; problem: string };
type Preview = { items: Item[]; ready: boolean; configured: boolean; secret_set: boolean;
  group: { media_id: string; synced_at: string; current: boolean } | null;
  unknown_operation: { op_id: string; created_at: string } | null };
type Result = { media_id?: string; action?: "created" | "updated" | "recreated"; count?: number; warnings?: string[]; note?: string;
  conflict?: boolean; needs_check?: boolean; message?: string };

const ACTION = { created: "已新建多图文草稿", updated: "已更新多图文草稿", recreated: "已重新建多图文草稿" } as const;
export const GROUP_LIMIT = 8;

export function WeChatGroupDialog({ open, documentIds, onClose, onDone }: {
  open: boolean; documentIds: string[]; onClose: () => void; onDone: () => void;
}) {
  const [order, setOrder] = React.useState<string[]>(documentIds);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<Result | null>(null);
  const [config, setConfig] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { if (open) { setOrder(documentIds); setPending(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useAccountQuery<Preview>("wechat.group_preview", { document_ids: order },
    { enabled: open && order.length >= 2, staleTime: 0, retry: false });
  const status = useAccountQuery<WeChatStatus>("wechat.status", {}, { enabled: open, staleTime: 0, retry: false });
  const ready = Boolean(status.data?.configured && status.data.secret_set);
  const move = (index: number, delta: number) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setOrder(next); setPending(null);
  };
  const remove = (index: number) => { setOrder(order.filter((_, i) => i !== index)); setPending(null); };
  const sync = async (extra: Record<string, unknown> = {}) => {
    const owner = accountStore.get(), here = () => alive.current && accountStore.get() === owner;
    const versions = preview.data?.items.map(item => item.version_id);
    setBusy(true); setPending(null);
    try {
      const result = await rpc<Result>("wechat.group_sync", { account_id: owner, document_ids: order, version_ids: versions, ...extra });
      void queryClient.invalidateQueries({ queryKey: ["ice", owner, "wechat.group_preview"] });
      void queryClient.invalidateQueries({ queryKey: ["ice", owner, "wechat.status"] });
      if (result.conflict || result.needs_check) { if (here()) setPending(result); return; }
      void invalidateDocuments(owner);
      toast.success({ title: `${ACTION[result.action ?? "created"]}（${result.count ?? order.length} 篇）`,
        detail: [result.note, ...(result.warnings ?? [])].filter(Boolean).join("；") });
      if (here()) onDone();
    } catch (error) {
      if (here()) toast.error({ title: "没有同步到草稿箱", detail: (error as Error).message });
      void queryClient.invalidateQueries({ queryKey: ["ice", owner, "wechat.group_preview"] });
    } finally { if (alive.current) setBusy(false); }
  };
  const data = preview.data;
  const byId = new Map<string, Item>((data?.items ?? []).map((item: Item) => [item.document_id, item] as [string, Item]));
  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }} title="合成多图文草稿" width={600}
      description="按下面的顺序写进公众号草稿箱，第一篇为头条。只写草稿，不发布。"
      footer={<>
        <Button onClick={onClose} disabled={busy}>关闭</Button>
        {!ready && <Button onClick={() => setConfig(true)}>设置公众号接口</Button>}
        <Button variant="primary" loading={busy} disabled={!ready || !data?.ready || order.length < 2 || Boolean(pending) || preview.isFetching}
                onClick={() => void sync()}>{data?.group ? "更新多图文草稿" : "同步为多图文草稿"}</Button>
      </>}>
      <div className="ice-doc-form">
        {order.length < 2 && <Banner tone="warning" title="至少需要 2 篇">多图文需要 2 到 {GROUP_LIMIT} 篇文章。关闭后重新选择。</Banner>}
        {preview.error && <Banner tone="warning" title="检查没有完成">{preview.error.message}</Banner>}
        <ol className="ice-doc-group" aria-label="多图文顺序">
          {order.map((id, index) => {
            const item = byId.get(id);
            return <li key={id} className={"ice-doc-group__item" + (item?.problem ? " is-blocked" : "")}>
              <span className="ice-doc-group__pos">{index === 0 ? "头条" : `第 ${index + 1} 篇`}</span>
              <span className="ice-doc-group__main">
                <strong>{item?.title || "（读取中）"}</strong>
                <span className="ice-doc-muted">
                  {item?.problem ? <span className="ice-doc-danger-text">{item.problem}</span>
                    : item?.version_created_at ? `用 ${formatTime(item.version_created_at)} 的稳定版本` : ""}
                  {item?.unversioned && !item.problem ? " · 工作副本里还有未保存成版本的修改，不会带上" : ""}
                </span>
              </span>
              <Button size="sm" variant="ghost" disabled={busy || index === 0} aria-label="上移" onClick={() => move(index, -1)}>↑</Button>
              <Button size="sm" variant="ghost" disabled={busy || index === order.length - 1} aria-label="下移" onClick={() => move(index, 1)}>↓</Button>
              <Button size="sm" variant="ghost" disabled={busy} aria-label="移出这组" onClick={() => remove(index)}>移出</Button>
            </li>;
          })}
        </ol>
        {data?.group ? <p className="ice-doc-muted">这组文章（按这个顺序）{formatTime(data.group.synced_at)} 同步过 · 草稿 …{data.group.media_id.slice(-6)}
            {data.group.current ? " · 与当前版本一致" : " · 有文章换了新版本，只更新变了的那几篇"}</p>
          : data && <p className="ice-doc-muted">这组文章（按这个顺序）还没有同步过，会新建一篇草稿。</p>}
        <p className="ice-doc-muted">调整顺序或增减文章会新建一篇草稿：公众号接口不能调整已有草稿的篇目和顺序。旧草稿留在后台，不需要时请自己删除。</p>
        {data?.unknown_operation && !pending && <Banner tone="warning" title="上次同步结果未知">
          上次同步这组文章时中断（{formatTime(data.unknown_operation.created_at)}）。同步前请先到后台草稿箱看看有没有这篇。</Banner>}
        {pending?.needs_check && <Banner tone="warning" title="上次同步结果未知">{pending.message}
          <div className="ice-doc-row"><Button size="sm" onClick={() => void sync({ checked_unknown: true })}>我已核对，继续同步</Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>稍后</Button></div></Banner>}
        {pending?.conflict && <Banner tone="warning" title="后台草稿被修改过">{pending.message}
          <div className="ice-doc-row"><Button size="sm" onClick={() => void sync({ mode: "new" })}>另建一篇草稿</Button>
            <Button size="sm" variant="ghost" className="ice-doc-danger-text" onClick={() => void sync({ mode: "overwrite" })}>用当前版本覆盖</Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>取消</Button></div></Banner>}
      </div>
      <WeChatConfigDialog open={config} onClose={() => setConfig(false)} status={status.data} />
    </Dialog>
  );
}
