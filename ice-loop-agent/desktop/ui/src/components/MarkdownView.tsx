import * as React from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { toast } from "./toast";
import { copyPlainText } from "../data/clipboard";
import { errorDisplay } from "./errorText";
import { safeMessageUrl } from "../features/chat/readingState";
import "../styles/conversation.css";

type Node = { type: string; value?: string; children?: Node[]; depth?: number; lang?: string;
  url?: string; title?: string; alt?: string; ordered?: boolean; start?: number; checked?: boolean | null;
  identifier?: string; align?: Array<"left" | "right" | "center" | null> };
const parser = unified().use(remarkParse).use(remarkGfm);

function CodeBlock({ node }: { node: Node }) {
  return <div className="ice-md-code">
    <div className="ice-md-code__bar"><span>{node.lang || "文本"}</span><CopyButton text={node.value ?? ""} label="复制代码" /></div>
    <pre tabIndex={0} aria-label={node.lang ? node.lang + " 代码" : "代码"}><code>{node.value}</code></pre>
  </div>;
}

function MarkdownLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [busy, setBusy] = React.useState(false), locked = React.useRef(false);
  const mounted = React.useRef(false), epoch = React.useRef(0);
  React.useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; };
  }, []);
  React.useLayoutEffect(() => { epoch.current++; }, [href]);
  return <button type="button" className="ice-md-link" title={"复制链接地址：" + href}
    aria-busy={busy || undefined} aria-disabled={busy || undefined}
    onClick={async () => {
      if (locked.current) return;
      locked.current = true; setBusy(true);
      const operation = ++epoch.current, current = () => mounted.current && epoch.current === operation;
      try { await copyPlainText(href); if (current()) toast.info("链接已复制"); }
      catch (error) {
        if (current()) {
          const feedback = errorDisplay(error);
          toast.error({ title: "复制失败", detail: [feedback.title, feedback.detail].filter(Boolean).join('：') });
        }
      } finally { locked.current = false; if (mounted.current) setBusy(false); }
    }}>{children}<span className="ice-sr-only">（复制链接地址）</span></button>;
}

/** remark parses Markdown; React renders an explicit element allowlist. Never execute model HTML. */
export const MarkdownView = React.memo(function MarkdownView({ text }: { text: string }) {
  const tree = React.useMemo(() => parser.parse(text) as unknown as Node, [text]);
  const definitions = new Map<string, Node>();
  for (const node of tree.children ?? []) if (node.type === "definition" && node.identifier) definitions.set(node.identifier, node);
  const children = (node: Node): React.ReactNode => node.children?.map((child, index) => <React.Fragment key={index}>{render(child)}</React.Fragment>);
  const link = (node: Node, target: Node = node) => {
    const href = safeMessageUrl(target.url);
    if (!href) return <span title="链接地址不可用">{children(node)}</span>;
    return <MarkdownLink href={href}>{children(node)}</MarkdownLink>;
  };
  function render(node: Node): React.ReactNode {
    switch (node.type) {
      case "text": return node.value;
      case "paragraph": return <p>{children(node)}</p>;
      case "heading": return React.createElement("h" + Math.min(6, Math.max(1, node.depth ?? 2)), null, children(node));
      case "strong": return <strong>{children(node)}</strong>;
      case "emphasis": return <em>{children(node)}</em>;
      case "delete": return <del>{children(node)}</del>;
      case "inlineCode": return <code>{node.value}</code>;
      case "code": return <CodeBlock node={node} />;
      case "blockquote": return <blockquote>{children(node)}</blockquote>;
      case "list": return node.ordered ? <ol start={node.start}>{children(node)}</ol> : <ul>{children(node)}</ul>;
      case "listItem": return <li>{node.checked != null && <input type="checkbox" checked={node.checked} disabled aria-label="任务状态" />}{children(node)}</li>;
      case "break": return <br />;
      case "thematicBreak": return <hr />;
      case "link": return link(node);
      case "linkReference": return link(node, definitions.get(node.identifier ?? "") ?? {} as Node);
      case "image": case "imageReference": return <span className="ice-md-image-note">[图片：{node.alt || "未命名"}]</span>;
      case "html": return <span className="ice-md-raw">{node.value}</span>;
      case "table": return <div className="ice-md-table" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>
        <thead><tr>{node.children?.[0]?.children?.map((cell, i) => <th key={i} style={{ textAlign: node.align?.[i] ?? "left" }}>{children(cell)}</th>)}</tr></thead>
        <tbody>{node.children?.slice(1).map((row, i) => <tr key={i}>{row.children?.map((cell, j) => <td key={j} style={{ textAlign: node.align?.[j] ?? "left" }}>{children(cell)}</td>)}</tr>)}</tbody>
      </table></div>;
      case "definition": return null;
      default: return node.children ? children(node) : node.value ?? null;
    }
  }
  return <div className="ice-markdown">{children(tree)}</div>;
});
