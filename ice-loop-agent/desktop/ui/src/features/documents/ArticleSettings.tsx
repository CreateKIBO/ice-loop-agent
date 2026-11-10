// 文章设置：封面与裁切、摘要、原文链接、留言。
import * as React from "react";
import type { Editor } from "@tiptap/react";

import { Button, Input } from "../../components/ui";
import { accountStore, useAccountQuery } from "../../data/client";
import { SUMMARY_LIMIT, type DocInfo, type ImageView } from "./documentsApi";
import { CoverCrop } from "./CoverCrop";
import { pickDocumentImage } from "./documentImages";

/** 文章设置（对应公众号编辑页的“文章设置”）：封面、摘要、原文链接。作者在标题下方填写。 */
export function ArticleSettings({ info, onChange, onClose, editor }: { info: DocInfo; onChange: (patch: Partial<DocInfo>) => void; onClose: () => void; editor: Editor | null }) {
  const firstImage = React.useMemo(() => {
    let id: string | null = null;
    editor?.state.doc.descendants(node => { if (!id && node.type.name === "articleImage" && node.attrs.resourceId) id = String(node.attrs.resourceId); return !id; });
    return id;
  }, [editor, info]);
  const coverId = info.coverResourceId || firstImage;
  const summary = info.summary ?? "";
  return (
    <div className="ice-doc-settings" role="dialog" aria-label="文章设置">
      <div className="ice-doc-row"><strong>文章设置</strong><span style={{ flex: 1 }} /><button type="button" className="ice-link-btn" onClick={onClose}>收起</button></div>
      <label>封面
        <div className="ice-doc-cover">
          {coverId ? <CoverThumb resourceId={coverId} /> : <div className="ice-doc-cover__empty">正文还没有图片</div>}
          <div className="ice-doc-cover__actions">
            <Button size="sm" onClick={async () => {
              const owner = accountStore.get(), target = editor;
              const image = await pickDocumentImage(owner);
              // 选择框打开期间离开文章或切号：不把封面写到别处。
              if (image && accountStore.get() === owner && target && !target.isDestroyed) onChange({ coverResourceId: image.resource_id });
            }}>另选封面</Button>
            {info.coverResourceId && <button type="button" className="ice-link-btn" onClick={() => onChange({ coverResourceId: "" })}>改回正文第一张图</button>}
          </div>
        </div>
        <span className="ice-doc-muted">{info.coverResourceId ? "已指定封面" : "默认取正文第一张图"}；导出图文包时另存为“封面”文件，便于在后台上传。</span>
      </label>
      {coverId && <CoverCrop resourceId={coverId} crop={info.coverCrop} onChange={coverCrop => onChange({ coverCrop })} />}
      <label>摘要
        <textarea aria-label="摘要" className="ice-doc-textarea" rows={3} maxLength={SUMMARY_LIMIT} value={summary} placeholder="选填，不填写则后台默认抓取正文前 54 字"
                  onChange={event => onChange({ summary: event.target.value })} />
        <span className="ice-doc-counter">{summary.length}/{SUMMARY_LIMIT}</span>
      </label>
      <label>原文链接（选填）
        <Input aria-label="原文链接（选填）" value={info.sourceUrl ?? ""} placeholder="https://" onChange={event => onChange({ sourceUrl: event.target.value })} />
      </label>
      <label>留言
        <select aria-label="留言设置" value={info.comments ?? "off"} onChange={event => onChange({ comments: event.target.value === "off" ? undefined : event.target.value as DocInfo["comments"] })}>
          <option value="off">关闭留言</option><option value="all">所有人可留言</option><option value="fans">仅关注者可留言</option>
        </select>
        <span className="ice-doc-muted">同步到草稿箱时生效；复制粘贴的文章请在后台设置。</span>
      </label>
      <p className="ice-doc-muted">这些信息随版本保存，并写入导出包的 manifest；粘贴到公众号后，请在后台对应位置填写。</p>
    </div>
  );
}

function CoverThumb({ resourceId }: { resourceId: string }) {
  // 与封面裁切共用同一个查询缓存：同一张图只读一次
  const view = useAccountQuery<ImageView>("documents.image_view", { resource_id: resourceId }, { staleTime: 60_000, retry: false });
  return view.data?.ok ? <img className="ice-doc-cover__img" src={view.data.preview} alt="封面" />
    : <div className="ice-doc-cover__empty">{view.isLoading ? "" : "封面图片缺失"}</div>;
}
