// Tiptap 自定义节点（M3-03）：imageSlot / runOutput / rawBlock。
// rawBlock 原样保留未知结构；runOutput 保持 run 引用不被重排。
import { Node, mergeAttributes } from "@tiptap/core";

export const ImageSlot = Node.create({
  name: "imageSlot",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      figureNo: { default: 1 },
      caption: { default: "" },
      kind: { default: "生图" },
      obtain: { default: "见配图方案表" },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-image-slot]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-image-slot": String(node.attrs.figureNo),
      class: "ice-editor-slot",
    }),
    ["strong", "图" + node.attrs.figureNo],
    " " + String(node.attrs.caption) + " · " + String(node.attrs.kind) + "｜" + String(node.attrs.obtain)];
  },
});

export const RunOutput = Node.create({
  name: "runOutput",
  group: "block",
  atom: true,
  addAttributes() {
    return { runRef: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-run-output]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-run-output": String(node.attrs.runRef),
      class: "ice-editor-run",
    }), "运行输出引用：" + String(node.attrs.runRef)];
  },
});

export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "pre[data-raw-block]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["pre", mergeAttributes(HTMLAttributes, {
      "data-raw-block": "1", class: "ice-editor-raw",
    }), String(node.attrs.source)];
  },
});
