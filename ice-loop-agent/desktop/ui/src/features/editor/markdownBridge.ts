// Markdown ↔ Tiptap JSON 桥（M3-02/03）。
// 结构解析用 remark（mdast）；未知结构（表格/HTML 等）转 rawBlock 原样保留，
// 序列化时原文返回——不静默重排。与 Python 侧 ice_agent/editorial 共用
// tests/fixtures/editorial-sample.md 做一致 fixture。
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { List, Parent, Root } from "mdast";

export interface EditorBlockJSON { type: string; attrs?: Record<string, unknown>; content?: EditorBlockJSON[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }

const PLACEHOLDER_RE = /^!\[图(\d+)：(.+?)\]\(待配图：(.+?)｜(.+?)\)\s*$/;
const RUN_OUTPUT_RE = /^<!--RUN_OUTPUT:(run-[A-Za-z0-9_-]+)-->\s*$/;

function inlineToContent(node: Parent): EditorBlockJSON[] {
  const out: EditorBlockJSON[] = [];
  for (const child of node.children as unknown as Array<Record<string, unknown> & { type: string }>) {
    switch (child.type) {
      case "text": out.push({ type: "text", text: String(child.value ?? "") }); break;
      case "strong": out.push(...wrapMarks(inlineToContent(child as unknown as Parent), "bold")); break;
      case "emphasis": out.push(...wrapMarks(inlineToContent(child as unknown as Parent), "italic")); break;
      case "inlineCode": out.push({ type: "text", text: String(child.value ?? ""), marks: [{ type: "code" }] }); break;
      case "link": out.push(...wrapMarks(inlineToContent(child as unknown as Parent), "link", { href: String(child.url ?? "") })); break;
      case "break": out.push({ type: "hardBreak" }); break;
      case "image": // 行内普通图片：保留为文本占位说明（块级占位符在段落分支处理）
        out.push({ type: "text", text: "![图片](" + String(child.url ?? "") + ")" }); break;
      default: out.push({ type: "text", text: plainText(child as unknown as Parent) });
    }
  }
  return out;
}

function wrapMarks(nodes: EditorBlockJSON[], mark: string, attrs?: Record<string, unknown>): EditorBlockJSON[] {
  return nodes.map(node => node.type === "text"
    ? { ...node, marks: [...(node.marks ?? []), ...(mark === "link" ? [{ type: mark, attrs }] : [{ type: mark }])] }
    : node);
}

function plainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(plainText).join("");
}

export function markdownToDoc(markdown: string): EditorBlockJSON {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const content: EditorBlockJSON[] = [];
  for (const child of tree.children as unknown as Array<Record<string, unknown> & { type: string }>) {
    switch (child.type) {
      case "heading":
        content.push({ type: "heading", attrs: { level: Number(child.depth ?? 1) },
                       content: inlineToContent(child as unknown as Parent) });
        break;
      case "paragraph": {
        // 单 image 子节点 = 图位占位符 `![图N：说明](待配图：类型｜获取方式)`
        // （remark 将其解析为标准 image 节点），在这里还原 imageSlot 语义。
        const kids = (child as unknown as Parent).children as unknown as Array<{ type: string; url?: unknown; alt?: unknown }>;
        if (kids.length === 1 && kids[0].type === "image") {
          const url = String(kids[0].url ?? "");
          const alt = String(kids[0].alt ?? "");
          const m = alt.match(/^图(\d+)：(.+)$/);
          if (url.startsWith("待配图：") && m) {
            const rest = url.slice("待配图：".length);
            const sep = rest.indexOf("｜");
            const kind = sep >= 0 ? rest.slice(0, sep) : rest;
            const obtain = sep >= 0 ? rest.slice(sep + 1) : "见配图方案表";
            content.push({ type: "imageSlot", attrs: { figureNo: Number(m[1]), caption: m[2],
                                                       kind: kind.trim(), obtain: obtain.trim() } });
            break;
          }
          content.push({ type: "rawBlock", attrs: { source: "![" + alt + "](" + url + ")" } });
          break;
        }
        const text = plainText(child as unknown as Parent).trim();
        const slot = text.match(PLACEHOLDER_RE);
        if (slot) {
          content.push({ type: "imageSlot", attrs: { figureNo: Number(slot[1]), caption: slot[2],
                                                     kind: slot[3], obtain: slot[4] } });
          break;
        }
        const run = text.match(RUN_OUTPUT_RE);
        if (run) {
          content.push({ type: "runOutput", attrs: { runRef: run[1] } });
          break;
        }
        content.push({ type: "paragraph", content: inlineToContent(child as unknown as Parent) });
        break;
      }
      case "code":
        content.push({ type: "codeBlock", attrs: { language: String(child.lang ?? "") },
                       content: [{ type: "text", text: String(child.value ?? "") }] });
        break;
      case "blockquote":
        content.push({ type: "blockquote", content: (child as unknown as Parent).children.map(inner =>
          inner.type === "paragraph"
            ? { type: "paragraph", content: inlineToContent(inner as unknown as Parent) }
            : { type: "paragraph", content: [{ type: "text", text: plainText(inner as unknown as Parent) }] }) });
        break;
      case "list": {
        const list = child as unknown as List;
        content.push({
          type: list.ordered ? "orderedList" : "bulletList",
          attrs: list.ordered ? { start: Number((list as { start?: number }).start ?? 1) } : {},
          content: (list.children as Parent[]).map(item => ({
            type: "listItem", content: item.children.map(inner =>
              inner.type === "paragraph"
                ? { type: "paragraph", content: inlineToContent(inner as unknown as Parent) }
                : { type: "paragraph", content: [{ type: "text", text: plainText(inner as unknown as Parent) }] }),
          })),
        });
        break;
      }
      case "thematicBreak": content.push({ type: "horizontalRule" }); break;
      case "html": {
        // HTML 注释运行输出引用与 Python 侧 run_output 对齐；其余 html → raw。
        const value = String(child.value ?? "").trim();
        const run = value.match(RUN_OUTPUT_RE);
        if (run) content.push({ type: "runOutput", attrs: { runRef: run[1] } });
        else content.push({ type: "rawBlock", attrs: { source: String(child.value ?? "") } });
        break;
      }
      default: {
        // 未知结构（table/html/yaml...）：raw 块字节保留。
        const position = (child as unknown as { position?: { start?: { offset?: number }; end?: { offset?: number } } }).position;
        const source = position
          ? markdown.slice(position.start?.offset ?? 0, position.end?.offset ?? 0)
          : plainText(child as unknown as Parent);
        content.push({ type: "rawBlock", attrs: { source } });
      }
    }
  }
  return { type: "doc", content };
}

// ---------------------------------------------------------------- 序列化
function serializeInline(nodes: EditorBlockJSON[] | undefined): string {
  if (!nodes) return "";
  return nodes.map(node => {
    const text = node.type === "text" ? (node.text ?? "")
      : node.type === "hardBreak" ? "\n"
      : serializeInline(node.content);
    let result = text;
    for (const mark of [...(node.marks ?? [])].reverse()) {
      if (mark.type === "bold") result = "**" + result + "**";
      else if (mark.type === "italic") result = "*" + result + "*";
      else if (mark.type === "code") result = "`" + result + "`";
      else if (mark.type === "link") result = "[" + result + "](" + String(mark.attrs?.href ?? "") + ")";
    }
    return result;
  }).join("");
}

export function docToMarkdown(doc: EditorBlockJSON): string {
  const blocks = (doc.content ?? []).map(serializeBlock);
  return blocks.join("\n\n");
}

function serializeBlock(node: EditorBlockJSON): string {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return "#".repeat(level) + " " + serializeInline(node.content);
    }
    case "paragraph": return serializeInline(node.content);
    case "codeBlock": {
      const lang = String(node.attrs?.language ?? "");
      return "```" + lang + "\n" + plainDocText(node) + "\n```";
    }
    case "blockquote": return (node.content ?? []).map(inner => "> " + serializeInline(inner.content)).join("\n");
    case "bulletList": return (node.content ?? []).map(item => "- " + listText(item)).join("\n");
    case "orderedList": return (node.content ?? []).map((item, i) => (i + 1) + ". " + listText(item)).join("\n");
    case "imageSlot": {
      const a = node.attrs ?? {};
      return "![图" + a.figureNo + "：" + a.caption + "](待配图：" + a.kind + "｜" + (a.obtain ?? "见配图方案表") + ")";
    }
    case "runOutput": return "<!--RUN_OUTPUT:" + String(node.attrs?.runRef ?? "") + "-->";
    case "rawBlock": return String(node.attrs?.source ?? "");
    case "horizontalRule": return "---";
    default: return serializeInline(node.content);
  }
}

function listText(item: EditorBlockJSON): string {
  return (item.content ?? []).map(inner => serializeInline(inner.content)).join("\n");
}

function plainDocText(node: EditorBlockJSON): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainDocText).join("");
}
