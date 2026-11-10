// 正文格式工具栏。
import * as React from "react";
import type { Editor } from "@tiptap/react";

import { Button, Input } from "../../components/ui";
import { HIGHLIGHTS, INLINE_FONT_SIZES, LETTER_SPACINGS, LINE_HEIGHTS, PARAGRAPH_SPACINGS, type DocStyle } from "./documentsApi";

const COLORS = ["#111827", "#6b7280", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777"];

/** 工具栏按钮。放在组件外：编辑器每次输入都会重绘工具栏，内联定义会让所有按钮每次重新挂载。 */
function T({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return <button type="button" className={"ice-doc-tool" + (active ? " is-active" : "")} aria-label={label} title={label}
                 aria-pressed={active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>;
}

function Swatches({ colors, current, onPick, reset, label }: { colors: string[]; current?: string | null; onPick: (c: string) => void; reset: string; label: string }) {
  return (
    <div className="ice-doc-pop__panel">
      <div className="ice-doc-swatches">
        {colors.map(color => <button key={color} type="button" style={{ background: color }} aria-label={label + " " + color} aria-pressed={current === color}
          onMouseDown={event => event.preventDefault()} onClick={() => onPick(color)} />)}
      </div>
      <button type="button" className="ice-link-btn" onMouseDown={event => event.preventDefault()} onClick={() => onPick("")}>{reset}</button>
    </div>
  );
}

export function EditorToolbar({ editor, style, onStyle }: { editor: Editor | null; style: DocStyle; onStyle: (patch: Partial<DocStyle>) => void }) {
  const [, force] = React.useReducer((value: number) => value + 1, 0);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [href, setHref] = React.useState("");
  React.useEffect(() => {
    if (!editor) return;
    editor.on("selectionUpdate", force); editor.on("transaction", force);
    return () => { editor.off("selectionUpdate", force); editor.off("transaction", force); };
  }, [editor]);
  React.useEffect(() => {
    const open = () => { if (editor) { setHref(String(editor.getAttributes("link").href ?? "")); setLinkOpen(true); } };
    document.addEventListener("ice-doc-link", open);
    return () => document.removeEventListener("ice-doc-link", open);
  }, [editor]);
  if (!editor) return <div className="ice-doc-toolbar" />;
  const chain = () => editor.chain().focus();
  const block = editor.isActive("heading", { level: 1 }) ? "h1" : editor.isActive("heading", { level: 2 }) ? "h2"
    : editor.isActive("heading", { level: 3 }) ? "h3" : "p";
  const align = (editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph").textAlign as string | null) ?? "left";
  const indent = Boolean(editor.getAttributes("paragraph").indent);
  const textStyle = editor.getAttributes("textStyle") as { color?: string | null; fontSize?: string | null; backgroundColor?: string | null };
  const setTextStyle = (patch: { color?: string | null; fontSize?: string | null; backgroundColor?: string | null }) => {
    const next = { color: textStyle.color ?? null, fontSize: textStyle.fontSize ?? null, backgroundColor: textStyle.backgroundColor ?? null, ...patch };
    if (!next.color && !next.fontSize && !next.backgroundColor) chain().unsetMark("textStyle").run();
    else chain().setMark("textStyle", next).run();
  };
  const setAlign = (value: string) => {
    const textAlign = value === "left" ? null : value;
    chain().updateAttributes("paragraph", { textAlign }).updateAttributes("heading", { textAlign }).run();
  };
  return (
    <div className="ice-doc-toolbar" role="toolbar" aria-label="正文格式">
      <T label="撤销 (Ctrl+Z)" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>↶</T>
      <T label="重做 (Ctrl+Shift+Z)" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>↷</T>
      <T label="清除格式" onClick={() => chain().unsetAllMarks().updateAttributes("paragraph", { textAlign: null, indent: null }).run()}>⌫</T>
      <span className="ice-doc-tool-sep" />
      <select aria-label="段落类型" value={block} onChange={event => {
        const value = event.target.value;
        if (value === "p") chain().setParagraph().run();
        else chain().setHeading({ level: Number(value[1]) as 1 | 2 | 3 }).run();
      }}>
        <option value="p">正文</option><option value="h1">大标题</option><option value="h2">小标题</option><option value="h3">三级标题</option>
      </select>
      <select aria-label="选中文字字号" title="选中文字的字号；全文字号在“一键排版”中设置" value={textStyle.fontSize ?? ""}
              onChange={event => setTextStyle({ fontSize: event.target.value || null })}>
        <option value="">{style.fontSize}px</option>{INLINE_FONT_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
      </select>
      <span className="ice-doc-tool-sep" />
      <T label="加粗 (Ctrl+B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}><b>B</b></T>
      <T label="斜体 (Ctrl+I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}><i>I</i></T>
      <T label="下划线 (Ctrl+U)" active={editor.isActive("underline")} onClick={() => chain().toggleUnderline().run()}><u>U</u></T>
      <T label="删除线" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}><s>S</s></T>
      <details className="ice-doc-pop">
        <summary className="ice-doc-tool" title="文字颜色" aria-label="文字颜色"><span style={{ borderBottom: `3px solid ${textStyle.color || "currentColor"}` }}>A</span></summary>
        <Swatches colors={[...new Set([style.brandColor, ...COLORS])]} current={textStyle.color} label="文字颜色" reset="恢复默认颜色"
                  onPick={color => setTextStyle({ color: color || null })} />
      </details>
      <details className="ice-doc-pop">
        <summary className="ice-doc-tool" title="背景色（高亮）" aria-label="背景色"><span className="ice-doc-hl" style={{ background: textStyle.backgroundColor || "#fff3a3" }}>ab</span></summary>
        <Swatches colors={HIGHLIGHTS} current={textStyle.backgroundColor} label="背景色" reset="清除背景色"
                  onPick={color => setTextStyle({ backgroundColor: color || null })} />
      </details>
      <span className="ice-doc-tool-sep" />
      {(["left", "center", "right", "justify"] as const).map(value =>
        <T key={value} label={{ left: "左对齐", center: "居中", right: "右对齐", justify: "两端对齐" }[value]} active={align === value}
           onClick={() => setAlign(value)}>{{ left: "⇤", center: "≡", right: "⇥", justify: "☰" }[value]}</T>)}
      <T label="首行缩进两字" active={indent} onClick={() => chain().updateAttributes("paragraph", { indent: indent ? null : true }).run()}>⇥¶</T>
      <select aria-label="全文行距" title="全文行距" value={style.lineHeight} onChange={event => onStyle({ lineHeight: Number(event.target.value) })}>
        {LINE_HEIGHTS.map(value => <option key={value} value={value}>行距 {value}</option>)}
      </select>
      <select aria-label="全文段距" title="全文段落间距" value={style.paragraphSpacing} onChange={event => onStyle({ paragraphSpacing: Number(event.target.value) })}>
        {PARAGRAPH_SPACINGS.map(value => <option key={value} value={value}>段距 {value}</option>)}
      </select>
      <select aria-label="全文字间距" title="全文字间距" value={style.letterSpacing ?? 0.5} onChange={event => onStyle({ letterSpacing: Number(event.target.value) })}>
        {LETTER_SPACINGS.map(value => <option key={value} value={value}>字距 {value}</option>)}
      </select>
      <span className="ice-doc-tool-sep" />
      <T label="无序列表" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>•≡</T>
      <T label="有序列表" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>1.</T>
      <T label="行内代码" active={editor.isActive("code")} onClick={() => chain().toggleCode().run()}>{"<>"}</T>
      <T label="链接" active={editor.isActive("link")} onClick={() => { setHref(String(editor.getAttributes("link").href ?? "")); setLinkOpen(value => !value); }}>🔗</T>
      {linkOpen && <form className="ice-doc-linkform" onSubmit={event => {
        event.preventDefault();
        const value = href.trim();
        if (!value) chain().extendMarkRange("link").unsetLink().run();
        else chain().extendMarkRange("link").setLink({ href: /^(https?:|mailto:)/i.test(value) ? value : "https://" + value }).run();
        setLinkOpen(false);
      }}>
        <Input autoFocus value={href} placeholder="https://" aria-label="链接地址" onChange={event => setHref(event.target.value)} />
        <Button size="sm" type="submit" variant="primary">确定</Button>
        <Button size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>取消</Button>
      </form>}
    </div>
  );
}
