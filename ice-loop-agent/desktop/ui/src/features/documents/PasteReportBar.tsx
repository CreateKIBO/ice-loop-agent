// 粘贴导入报告条：显示转换结果，切换“按当前样式 / 仅保留文字”。
import * as React from "react";

import { Button, Spinner } from "../../components/ui";
import type { ImportReport } from "./documentsApi";

export type PasteState = { html: string; mode: "adapt" | "text"; report: ImportReport; seq: number } | null;

export function PasteReportBar({ state, busy, onToggle, onClose }: { state: PasteState; busy: boolean; onToggle: () => void; onClose: () => void }) {
  const [open, setOpen] = React.useState(false);
  if (!state) return <div className="ice-doc-report"><Spinner size={12} /> 正在转换粘贴内容…</div>;
  const r = state.report;
  const missing = r.images.missing.length, islands = r.islands.length;
  const dropped = Object.entries(r.dropped).filter(([key]) => !["meta", "link", "head", "title"].includes(key));
  return (
    <div className={"ice-doc-report" + (missing || islands ? " is-warning" : "")} role="status">
      <strong>{state.mode === "adapt" ? "已按当前样式粘贴" : "已仅保留文字"}</strong>
      <span>{r.paragraphs} 段 · {r.headings} 个标题 · 图片 {r.images.imported}/{r.images.total}</span>
      {missing > 0 && <span className="is-warn">{missing} 张图片需要替换</span>}
      {islands > 0 && <span className="is-warn">{islands} 个未支持模块保留为只读原件</span>}
      <span style={{ flex: 1 }} />
      <button type="button" className="ice-link-btn" onClick={() => setOpen(value => !value)}>{open ? "收起报告" : "查看报告"}</button>
      <Button size="sm" loading={busy} onClick={onToggle}>{state.mode === "adapt" ? "改为仅保留文字" : "恢复适配样式"}</Button>
      <button type="button" className="ice-link-btn" onClick={onClose} aria-label="关闭导入报告">关闭</button>
      {open && <div className="ice-doc-report__detail">
        {r.images.missing.map((item, index) => <div key={index}>缺图：{item.alt || "未命名"} — {item.reason}{item.src && item.src !== "data:…" ? `（${item.src}）` : ""}</div>)}
        {r.islands.map((item, index) => <div key={"i" + index}>原件：{item.reason}「{item.preview.slice(0, 40)}」</div>)}
        {Object.keys(r.styles.ignored).length > 0 && <div>未映射样式：{Object.entries(r.styles.ignored).map(([k, v]) => `${k}×${v}`).join("、")}</div>}
        {dropped.length > 0 && <div>已移除（不安全或无法交付）：{dropped.map(([k, v]) => `${k}×${v}`).join("、")}</div>}
        <div className="ice-doc-muted">原始粘贴内容已留档；切换模式可用 Ctrl+Z 撤销。</div>
      </div>}
    </div>
  );
}
