// P2 素材库：浏览当前公众号的图片资源，按标签/名称筛选，编辑标签，插入正文。
import * as React from "react";

import { Button, Dialog, Input, SkeletonRows } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { docRpc, formatBytes, type ImageView } from "./documentsApi";

type LibraryItem = { resource_id: string; title: string; width: number; height: number; mime: string; size: number; tags: string[]; source_kind: string };
type Library = { items: LibraryItem[]; total: number; offset: number; tags: Array<{ tag: string; count: number }> };
const PAGE = 40;

function Thumb({ id }: { id: string }) {
  const view = useAccountQuery<ImageView>("documents.image_view", { resource_id: id }, { staleTime: 5 * 60_000 });
  return view.data?.ok ? <img src={view.data.preview} alt="" loading="lazy" draggable={false} /> : <span className="ice-lib__ph">{view.isLoading ? "…" : "缺失"}</span>;
}

export function MaterialLibrary({ open, onClose, onInsert }: { open: boolean; onClose: () => void; onInsert: (resourceId: string) => void }) {
  const account = useCurrentAccount();
  const [query, setQuery] = React.useState("");
  const [tag, setTag] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [picked, setPicked] = React.useState<LibraryItem | null>(null);
  const [tagText, setTagText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const deferred = React.useDeferredValue(query.trim());
  React.useEffect(() => setOffset(0), [deferred, tag]);
  const data = useAccountQuery<Library>("documents.library", { query: deferred, tag, offset, limit: PAGE }, { enabled: open, staleTime: 0 });
  React.useEffect(() => { setTagText((picked?.tags ?? []).join("，")); }, [picked]);

  const saveTags = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const tags = tagText.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean);
      const result = await docRpc<{ tags: string[] }>("documents.image_tags", { resource_id: picked.resource_id, tags });
      setPicked({ ...picked, tags: result.tags });
      void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.library"] });
      toast.success({ title: "标签已保存" });
    } catch (error) { toast.error({ title: "标签没有保存", detail: (error as Error).message }); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title="素材库" width={820}
            description="当前公众号导入过的全部图片（粘贴、截图、本地文件、Word、裁切结果）。可按标签整理，选一张插入正文。"
            footer={<><span className="ice-doc-muted" style={{ flex: 1 }}>{data.data ? `共 ${data.data.total} 张` : ""}</span>
              <Button onClick={onClose}>关闭</Button>
              <Button variant="primary" disabled={!picked} onClick={() => { if (picked) { onInsert(picked.resource_id); onClose(); } }}>插入正文</Button></>}>
      <div className="ice-lib">
        <div className="ice-doc-row">
          <Input type="search" value={query} placeholder="按名称、标签、原文件名搜索" aria-label="搜索素材" onChange={event => setQuery(event.target.value)} style={{ flex: 1 }} />
        </div>
        {(data.data?.tags.length ?? 0) > 0 && <div className="ice-lib__tags" role="group" aria-label="按标签筛选">
          <button type="button" className={"ice-doc-chip" + (!tag ? " is-busy" : "")} onClick={() => setTag("")}>全部</button>
          {data.data!.tags.map(item => <button key={item.tag} type="button" className={"ice-doc-chip" + (tag === item.tag ? " is-busy" : "")}
            onClick={() => setTag(tag === item.tag ? "" : item.tag)}>#{item.tag} {item.count}</button>)}
        </div>}
        {data.isLoading && <SkeletonRows rows={3} height={60} />}
        {data.error && <ErrorNote error={data.error} onRetry={() => data.refetch()} retryLabel="重新读取素材" />}
        {data.data && !data.data.items.length && <p className="ice-doc-muted">没有符合条件的图片。</p>}
        <div className="ice-lib__body">
          <ul className="ice-lib__grid" aria-label="素材">
            {(data.data?.items ?? []).map(item => <li key={item.resource_id}>
              <button type="button" className={"ice-lib__cell" + (picked?.resource_id === item.resource_id ? " is-on" : "")}
                      aria-pressed={picked?.resource_id === item.resource_id} title={item.title}
                      onClick={() => setPicked(item)} onDoubleClick={() => { onInsert(item.resource_id); onClose(); }}>
                <Thumb id={item.resource_id} />
                <span>{item.tags.length ? item.tags.map(t => "#" + t).join(" ") : item.title || "未命名"}</span>
              </button></li>)}
          </ul>
          {picked && <aside className="ice-lib__detail" aria-label="所选图片">
            <Thumb id={picked.resource_id} />
            <strong>{picked.title || "未命名"}</strong>
            <span className="ice-doc-muted">{picked.width}×{picked.height} · {formatBytes(picked.size)}</span>
            <label className="ice-doc-field">标签（逗号或空格分隔，最多 10 个）
              <Input value={tagText} maxLength={240} aria-label="图片标签" onChange={event => setTagText(event.target.value)}
                     onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void saveTags(); } }} /></label>
            <Button size="sm" loading={saving} onClick={() => void saveTags()}>保存标签</Button>
          </aside>}
        </div>
        {data.data && data.data.total > PAGE && <div className="ice-doc-row">
          <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
          <span className="ice-doc-muted">{offset + 1}–{Math.min(offset + PAGE, data.data.total)} / {data.data.total}</span>
          <Button size="sm" variant="ghost" disabled={offset + PAGE >= data.data.total} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
        </div>}
      </div>
    </Dialog>
  );
}
