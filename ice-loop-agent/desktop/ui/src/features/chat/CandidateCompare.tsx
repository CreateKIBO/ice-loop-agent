// 批A/B（2026-10-25 候选对照）：当前页两份候选的只读对照面板。
// 设计约束：
// - 只选择“当前已加载页”内的候选（A1）：分页/切会话/切账号时清空选择并就地说明（A6），
//   不保留正文副本——仅存有限 ID/标题/字符数，打开面板时从当前页数据重新取完整正文。
// - 零写类 RPC（A3）：面板只读，不发保存/采纳/提交，不触发模型。
// - 各自复制严格取对应 candidate.body（A5），复用修复后的 CopyButton。
// - 布局（B1）：≥1280 并排、窄屏上下堆叠，每份独立滚动，不产生整窗横向溢出。
// - 局部目录（B2）：从当前候选正文构建（复用 markdownBridge 的 AST 标题解析，
//   代码围栏中的伪标题天然不入目录）；点击只滚动本面板内部。
// - 回到开头（B3）：仅在已向下滚动时启用；减弱动效立即定位（B3/D6）。
// - 键盘（B5）：展开控件 aria-expanded/aria-controls；关闭后焦点返回触发按钮。
import * as React from "react";
import { Button, Dialog } from "../../components/ui";
import { CopyButton } from "../../components/CopyButton";
import { MarkdownContent } from "../../components/MarkdownContent";
import { markdownHeadings, type MarkdownHeading } from "../editor/markdownBridge";

export type ComparePick = { id: string; title: string; chars: number };

/** 选择状态机（纯函数，供单测）：恰好两份、不重复、三选时明确拒绝。 */
export function toggleComparePick(picks: ComparePick[], candidate: ComparePick): { next: ComparePick[]; note?: string } {
  if (picks.some(pick => pick.id === candidate.id)) {
    return { next: picks.filter(pick => pick.id !== candidate.id), note: "已从对照中移除" };
  }
  if (picks.length >= 2) {
    return { next: picks, note: "对照最多两份：请先移除一份再加入" };
  }
  return { next: [...picks, candidate] };
}

export function compareStatusNote(picks: ComparePick[]): string {
  if (picks.length === 0) return "未选择对照";
  if (picks.length === 1) return `已选 1 份（${picks[0].title.slice(0, 20)}），再选一份即可对照`;
  return "已选 2 份，可打开对照";
}

// DOM text preserves lone CR, but Chromium does not lay it out as a line
// break. Add a visual break only there; keep CRLF/LF and copied source intact.
function sourceText(text: string): React.ReactNode {
  return text.split(/(\r(?!\n))/).map((part, index) => part === "\r"
    ? <React.Fragment key={index}>{part}<br /></React.Fragment> : part);
}

/** 面板内单份候选的只读阅读区（阅读/原文 + 局部目录 + 回到开头 + 独立复制）。 */
function ComparePane({ candidate, narrow }: { candidate: { id: string; title: string; body: string; status: string }; narrow: boolean }) {
  const [reading, setReading] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = React.useState(false);
  const headings = React.useMemo(() => markdownHeadings(candidate.body), [candidate.body]);
  // Anchor only real top-level headings, preserving every source character.
  // Match the AST's line endings without normalizing any source characters.
  const sourceSections = React.useMemo(() => {
    const lines = [0];
    for (const ending of candidate.body.matchAll(/\r\n|\r|\n/g)) {
      lines.push(ending.index + ending[0].length);
    }
    const starts = headings.map(heading => lines[heading.line - 1]);
    return {
      prefix: candidate.body.slice(0, starts[0] ?? candidate.body.length),
      sections: headings.map((heading, index) => ({ index: heading.index,
        text: candidate.body.slice(starts[index], starts[index + 1] ?? candidate.body.length) })),
    };
  }, [candidate.body, headings]);
  const [tocOpen, setTocOpen] = React.useState(false);
  const reduced = usePrefersReducedMotion();
  const onScroll = () => {
    const node = scrollRef.current;
    setScrolled(Boolean(node && node.scrollTop > 8));
  };
  const scrollToPoint = (target: number | "top") => {
    const node = scrollRef.current;
    if (!node) return;
    const top = target === "top" ? 0 : target;
    if (reduced) node.scrollTo({ top, behavior: "auto" });
    else node.scrollTo({ top, behavior: "smooth" });
  };
  const gotoHeading = (heading: MarkdownHeading) => {
    const node = scrollRef.current;
    if (!node) return;
    // Match the AST's top-level h1–h6 only; headings inside quoted examples
    // must not shift the directory index. Raw view uses exact source anchors.
    const root = node.querySelector('.ice-markdown');
    const element = reading
      ? Array.from(root?.children ?? []).filter(child => /^H[1-6]$/.test(child.tagName))[heading.index]
      : node.querySelector(`[data-compare-heading="${heading.index}"]`);
    if (element) scrollToPoint(node.scrollTop + element.getBoundingClientRect().top - node.getBoundingClientRect().top - 10);
  };
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0, flex: narrow ? "1 1 auto" : "1 1 0" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", minWidth: 0 }}>
        <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={candidate.title}>
          {candidate.title}
        </strong>
        <span className="ice-composer-note" style={{ flexShrink: 0 }}>{candidate.body.length.toLocaleString()} 字符</span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} role="group" aria-label={`对照查看方式（${candidate.title.slice(0, 12)}）`}>
        <Button size="sm" variant={reading ? "primary" : "secondary"} aria-pressed={reading} onClick={() => setReading(true)}>阅读预览</Button>
        <Button size="sm" variant={!reading ? "primary" : "secondary"} aria-pressed={!reading} onClick={() => setReading(false)}>Markdown 原文</Button>
        <CopyButton text={candidate.body} label="复制此份原文" successLabel="此份已复制" />
        <button type="button" className="ice-link-btn" aria-expanded={tocOpen} aria-controls={`compare-toc-${candidate.id}`}
                onClick={() => setTocOpen(value => !value)}>
          {tocOpen ? "收起目录" : `目录（${headings.length}）`}
        </button>
        <button type="button" className="ice-link-btn" disabled={!scrolled} title={scrolled ? "回到本栏开头" : "尚未向下阅读"}
                onClick={() => scrollToPoint("top")}>回到开头</button>
      </div>
      {tocOpen && (
        <nav id={`compare-toc-${candidate.id}`} aria-label="本栏目录" style={{ maxHeight: 140, overflowY: "auto", fontSize: "var(--ice-font-size-sm)",
                                  padding: "4px 8px", background: "var(--ice-surface-muted)", borderRadius: 6 }}>
          {headings.length === 0 && <span className="ice-composer-note">本份没有 Markdown 标题</span>}
          {headings.map(heading => (
            <button key={heading.index} type="button" className="ice-link-btn" style={{ display: "block", paddingLeft: (heading.level - 1) * 12 }}
                    onClick={() => gotoHeading(heading)}>{heading.text}</button>
          ))}
        </nav>
      )}
      <div ref={scrollRef} onScroll={onScroll} style={{ minHeight: 200, maxHeight: 460, overflowY: "auto", background: "var(--ice-surface-muted)",
                           padding: 10, borderRadius: 8, fontSize: "var(--ice-font-size-sm)", minWidth: 0 }}>
        {reading
          ? <MarkdownContent text={candidate.body} />
          : <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--ice-font-mono)", overflowWrap: "anywhere" }}>{sourceText(sourceSections.prefix)}{sourceSections.sections.map(section =>
              <span key={section.index} data-compare-heading={section.index}>{sourceText(section.text)}</span>)}</pre>}
      </div>
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

export function CandidateCompareDialog({ open, onOpenChange, pair }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  pair: Array<{ id: string; title: string; body: string; status: string }>;
}) {
  // Resizing must update this open dialog even when the chat query and virtual
  // rows stay unchanged. Keep both readers mounted across the breakpoint.
  const [narrow, setNarrow] = React.useState(() => window.matchMedia('(max-width: 999px)').matches);
  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 999px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  if (pair.length !== 2) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={narrow ? 720 : 1200}
            title="候选对照（只读）"
            description={`当前页候选的并排阅读：${pair[0].title.slice(0, 18)} 与 ${pair[1].title.slice(0, 18)}。对照不修改任何候选状态，也不发送保存或提交请求。`}>
      <div style={{ display: "flex", gap: 12, minWidth: 0, flexDirection: narrow ? "column" : "row", alignItems: "stretch" }}>
        <ComparePane candidate={pair[0]} narrow={narrow} />
        <ComparePane candidate={pair[1]} narrow={narrow} />
      </div>
    </Dialog>
  );
}
