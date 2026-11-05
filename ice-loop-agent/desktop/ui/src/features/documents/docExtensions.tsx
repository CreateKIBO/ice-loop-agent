// v3 文档编辑器扩展（B-01/B-02/B-03）：稳定块 id、对齐、局部样式、真实图片块、未支持模块原件岛。
// 节点/属性与后端 ice_agent/documents/schema.py 一一对应；后端仍会再次规范化，前端不是安全边界。
import { Extension, Mark, Node, mergeAttributes, type NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import * as React from "react";

import { useCurrentAccount } from "../../data/client";
import { ImageSlot as LegacyImageSlot, RawBlock as LegacyRawBlock, RunOutput as LegacyRunOutput } from "../editor/nodes";
import { docRpc, formatBytes, newBlockId, type ImageView } from "./documentsApi";

export const BLOCK_TYPES = ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "horizontalRule",
  "codeBlock", "articleImage", "rawHtml", "rawBlock", "imageSlot", "runOutput"];

/** 每个块带稳定 id（版本对比、交付问题定位、图片顺序）。拆分/粘贴产生的重复或缺失 id 在同一事务后补齐。 */
export const BlockId = Extension.create({
  name: "blockId",
  addGlobalAttributes() {
    return [{
      types: BLOCK_TYPES,
      attributes: {
        id: {
          default: null,
          keepOnSplit: false,
          parseHTML: element => element.getAttribute("data-bid"),
          renderHTML: attributes => attributes.id ? { "data-bid": attributes.id } : {},
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    const types = new Set(BLOCK_TYPES);
    return [new Plugin({
      key: new PluginKey("ice-block-id"),
      appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null;
        const seen = new Set<string>();
        let tr = state.tr, changed = false;
        state.doc.descendants((node, pos) => {
          if (!types.has(node.type.name)) return true;
          const id = node.attrs.id as string | null;
          if (!id || seen.has(id)) {
            const next = newBlockId();
            seen.add(next);
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: next });
            changed = true;
          } else seen.add(id);
          return true;
        });
        if (!changed) return null;
        tr.setMeta("addToHistory", false);
        return tr;
      },
    })];
  },
});

export const TextAlign = Extension.create({
  name: "iceTextAlign",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        textAlign: {
          default: null,
          parseHTML: element => {
            const value = element.style.textAlign;
            return ["center", "right", "justify"].includes(value) ? value : null;
          },
          renderHTML: attributes => attributes.textAlign ? { style: `text-align:${attributes.textAlign}` } : {},
        },
      },
    }];
  },
});

/** 局部样式：颜色与字号（受限集合）。其余 CSS 不进入正文。 */
export const TextStyle = Mark.create({
  name: "textStyle",
  addAttributes() {
    return {
      color: { default: null, parseHTML: element => element.style.color || null },
      fontSize: { default: null, parseHTML: element => element.style.fontSize || null },
    };
  },
  parseHTML() {
    return [{ tag: "span[style]", getAttrs: element => {
      const el = element as HTMLElement;
      return el.style.color || el.style.fontSize ? {} : false;
    } }];
  },
  renderHTML({ HTMLAttributes }) {
    const css = [HTMLAttributes.color ? `color:${HTMLAttributes.color}` : "", HTMLAttributes.fontSize ? `font-size:${HTMLAttributes.fontSize}` : ""]
      .filter(Boolean).join(";");
    return ["span", css ? { style: css } : {}, 0];
  },
});

// ------------------------------------------------------------------ 图片块
export type ImageActions = {
  pickImage: () => Promise<ImageView | null>;
};
export const imageActions: { current: ImageActions | null } = { current: null };

function useImageView(resourceId: string) {
  const account = useCurrentAccount();
  return useQuery<ImageView>({
    queryKey: ["ice", account, "documents.image_view", { resource_id: resourceId }],
    queryFn: () => docRpc<ImageView>("documents.image_view", { resource_id: resourceId }),
    enabled: Boolean(account && resourceId), staleTime: 5 * 60_000, gcTime: 10 * 60_000,
  });
}

function ArticleImageView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const attrs = node.attrs as { resourceId: string; caption: string; width: number; align: "left" | "center" | "right"; sourceUrl: string };
  const view = useImageView(attrs.resourceId);
  const [busy, setBusy] = React.useState(false);
  const editable = editor.isEditable;
  const replace = async () => {
    if (!imageActions.current || busy) return;
    setBusy(true);
    try { const picked = await imageActions.current.pickImage(); if (picked) updateAttributes({ resourceId: picked.resource_id }); }
    finally { setBusy(false); }
  };
  const missing = view.data && !view.data.ok;
  return (
    <NodeViewWrapper className={"ice-doc-image" + (selected ? " is-selected" : "")} data-align={attrs.align} data-drag-handle>
      <figure style={{ width: `${attrs.width}%` }} contentEditable={false}>
        {view.isLoading ? <div className="ice-doc-image__placeholder">正在载入图片…</div>
          : view.error || missing ? <div className="ice-doc-image__placeholder is-missing">图片文件缺失或已改变，请替换</div>
          : <img src={view.data?.preview} alt={attrs.caption} draggable={false} />}
      </figure>
      {editable && <div className="ice-doc-image__bar" contentEditable={false}>
        <select aria-label="图片宽度" value={attrs.width} onChange={event => updateAttributes({ width: Number(event.target.value) })}>
          {[100, 80, 60, 40].map(width => <option key={width} value={width}>{width}%</option>)}
        </select>
        <div className="ice-doc-seg" role="group" aria-label="图片对齐">
          {(["left", "center", "right"] as const).map(align => (
            <button key={align} type="button" aria-pressed={attrs.align === align} onClick={() => updateAttributes({ align })}>
              {align === "left" ? "左" : align === "center" ? "中" : "右"}</button>))}
        </div>
        <button type="button" className="ice-link-btn" disabled={busy} onClick={() => void replace()}>{busy ? "选择中…" : "替换"}</button>
        <button type="button" className="ice-link-btn" onClick={() => deleteNode()}>删除</button>
        {view.data?.ok && <span className="ice-doc-muted">{view.data.width}×{view.data.height} · {formatBytes(view.data.size)}</span>}
      </div>}
      <input className="ice-doc-image__caption" value={attrs.caption} placeholder={editable ? "添加图注（可选）" : ""}
             readOnly={!editable} maxLength={300} aria-label="图注"
             onChange={event => updateAttributes({ caption: event.target.value, alt: event.target.value })}
             onKeyDown={event => event.stopPropagation()} />
    </NodeViewWrapper>
  );
}

export const ArticleImage = Node.create({
  name: "articleImage",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      resourceId: { default: "" }, caption: { default: "" }, alt: { default: "" },
      width: { default: 100 }, align: { default: "center" }, sourceUrl: { default: "" },
    };
  },
  // 编辑器内部复制/拖动时用 data-* 保留全部属性（外部 HTML 粘贴走引擎转换，不经此规则）。
  parseHTML() { return [{ tag: "figure[data-resource-id]", getAttrs: (el: HTMLElement) => ({
    resourceId: el.dataset.resourceId, caption: el.dataset.caption ?? "", alt: el.dataset.caption ?? "",
    width: Number(el.dataset.width) || 100, align: el.dataset.align || "center", sourceUrl: el.dataset.sourceUrl ?? "" }) }]; },
  renderHTML({ node }: { node: { attrs: Record<string, unknown> } }) {
    const a = node.attrs;
    return ["figure", mergeAttributes({ "data-resource-id": a.resourceId, "data-caption": a.caption, "data-width": String(a.width),
      "data-align": a.align, "data-source-url": a.sourceUrl })];
  },
  addNodeView() { return ReactNodeViewRenderer(ArticleImageView); },
});

function SlotView({ node, editor, getPos }: NodeViewProps) {
  const attrs = node.attrs as { figureNo: number; caption: string; kind: string; obtain: string };
  const [busy, setBusy] = React.useState(false);
  const fill = async () => {
    if (!imageActions.current || busy) return;
    setBusy(true);
    try {
      const picked = await imageActions.current.pickImage();
      const pos = typeof getPos === "function" ? getPos() : null;
      if (!picked || pos == null) return;
      editor.chain().focus().insertContentAt({ from: pos, to: pos + node.nodeSize }, {
        type: "articleImage", attrs: { resourceId: picked.resource_id, caption: attrs.caption, alt: attrs.caption, width: 100, align: "center" },
      }).run();
    } finally { setBusy(false); }
  };
  const remote = attrs.obtain?.startsWith("http");
  return (
    <NodeViewWrapper className="ice-doc-slot" data-drag-handle>
      <div contentEditable={false}>
        <strong>{attrs.kind === "粘贴缺图" ? "缺失的图片" : `图${attrs.figureNo} 待配图`}</strong>
        <span>{attrs.caption}</span>
        {remote ? <span className="ice-doc-muted" title={attrs.obtain}>来源：{attrs.obtain}</span>
          : attrs.obtain && <span className="ice-doc-muted">{attrs.obtain}</span>}
        {editor.isEditable && <button type="button" className="ice-btn ice-btn--secondary ice-btn--sm" disabled={busy}
          onClick={() => void fill()}>{busy ? "选择中…" : "插入图片"}</button>}
      </div>
    </NodeViewWrapper>
  );
}
export const DocImageSlot = LegacyImageSlot.extend({ addNodeView() { return ReactNodeViewRenderer(SlotView); } });

// ------------------------------------------------------------- 原件岛（只读）
function RawHtmlView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const attrs = node.attrs as { html: string; reason: string; deliver: "text" | "html" | "omit" };
  const [source, setSource] = React.useState(false);
  const safe = React.useMemo(() => DOMPurify.sanitize(attrs.html, {
    FORBID_TAGS: ["style", "script", "iframe", "form", "input", "svg", "math", "img"], FORBID_ATTR: ["srcset"],
  }), [attrs.html]);
  return (
    <NodeViewWrapper className="ice-doc-island" data-drag-handle>
      <div className="ice-doc-island__head" contentEditable={false}>
        <span className="ice-doc-badge">未支持模块 · 只读原件</span>
        <span className="ice-doc-muted">{attrs.reason}</span>
        <span style={{ flex: 1 }} />
        <label className="ice-doc-muted">交付时
          <select value={attrs.deliver} disabled={!editor.isEditable}
                  onChange={event => updateAttributes({ deliver: event.target.value })}>
            <option value="text">降级为文字</option><option value="html">按原 HTML（未验证）</option><option value="omit">省略</option>
          </select></label>
        <button type="button" className="ice-link-btn" onClick={() => setSource(value => !value)}>{source ? "看预览" : "看原件"}</button>
        {editor.isEditable && <button type="button" className="ice-link-btn" onClick={() => deleteNode()}>移除</button>}
      </div>
      {/<img\b/i.test(attrs.html) && <p className="ice-doc-muted" contentEditable={false}>原件中的图片未归档，预览不加载外链图片。请在正文中独立插入图片。</p>}
      {source ? <pre className="ice-doc-island__source" contentEditable={false}>{attrs.html}</pre>
        // 已由引擎白名单清洗，再经 DOMPurify；只作隔离预览，不可编辑、不响应点击。
        : <div className="ice-doc-island__preview" contentEditable={false} dangerouslySetInnerHTML={{ __html: safe }} />}
    </NodeViewWrapper>
  );
}
export const RawHtml = Node.create({
  name: "rawHtml",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() { return { html: { default: "" }, reason: { default: "" }, deliver: { default: "text" } }; },
  parseHTML() { return [{ tag: "div[data-raw-html]", getAttrs: (el: HTMLElement) => ({
    html: el.dataset.html ?? "", reason: el.dataset.reason ?? "", deliver: el.dataset.deliver || "text" }) }]; },
  renderHTML({ node }: { node: { attrs: Record<string, unknown> } }) {
    return ["div", { "data-raw-html": "1", "data-html": node.attrs.html, "data-reason": node.attrs.reason, "data-deliver": node.attrs.deliver }];
  },
  addNodeView() { return ReactNodeViewRenderer(RawHtmlView); },
});

function RunOutputView({ node }: NodeViewProps) {
  return <NodeViewWrapper className="ice-doc-legacy" data-drag-handle><div contentEditable={false}>
    <span className="ice-doc-badge">历史运行输出</span> {String(node.attrs.runRef)} · 代码执行已退场，交付时省略</div></NodeViewWrapper>;
}
export const DocRunOutput = LegacyRunOutput.extend({ addNodeView() { return ReactNodeViewRenderer(RunOutputView); } });
export const DocRawBlock = LegacyRawBlock;
