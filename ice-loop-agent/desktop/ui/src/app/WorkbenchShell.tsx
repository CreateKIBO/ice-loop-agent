// 三栏创作工作台壳（M2-03）：可拖动分栏、最小宽度、专注模式占位。
// 布局持久化经 window.localStorage（后续迁到对象级工作区设置）。
import * as React from "react";

import { EmptyState } from "../components/ui";

export interface PaneSizes { left: number; right: number }

const DEFAULTS: PaneSizes = { left: 260, right: 380 };
const MIN_LEFT = 200, MIN_RIGHT = 280;

function loadSizes(): PaneSizes {
  try {
    const raw = window.localStorage.getItem("ice.ui.panes");
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PaneSizes>;
    return {
      left: Math.max(MIN_LEFT, Number(parsed.left) || DEFAULTS.left),
      right: Math.max(MIN_RIGHT, Number(parsed.right) || DEFAULTS.right),
    };
  } catch {
    return DEFAULTS;
  }
}

function Divider({ onDrag }: { onDrag: (deltaPx: number) => void }) {
  const start = React.useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      style={{ width: 5, cursor: "col-resize", background: "transparent", flexShrink: 0 }}
      onPointerDown={event => {
        start.current = event.clientX;
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (start.current === null) return;
        onDrag(event.clientX - start.current);
        start.current = event.clientX;
      }}
      onPointerUp={() => { start.current = null; }}
      onKeyDown={event => {
        if (event.key === "ArrowLeft") onDrag(-16);
        if (event.key === "ArrowRight") onDrag(16);
      }}
    />
  );
}

export function WorkbenchShell({ left, center, right }: {
  left: React.ReactNode; center: React.ReactNode; right: React.ReactNode;
}) {
  const [sizes, setSizes] = React.useState<PaneSizes>(loadSizes);
  const persistTimer = React.useRef<number | undefined>(undefined);

  const apply = React.useCallback((patch: Partial<PaneSizes>) => {
    setSizes(previous => {
      const next = {
        left: Math.max(MIN_LEFT, patch.left ?? previous.left),
        right: Math.max(MIN_RIGHT, patch.right ?? previous.right),
      };
      window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        try { window.localStorage.setItem("ice.ui.panes", JSON.stringify(next)); } catch { /* 无持久化不阻塞 */ }
      }, 400);
      return next;
    });
  }, []);

  React.useEffect(() => () => window.clearTimeout(persistTimer.current), []);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, overflow: "hidden" }}>
      <nav aria-label="工作区导航" style={{
        width: sizes.left, flexShrink: 0, background: "var(--ice-surface-muted)",
        borderRight: "1px solid var(--ice-border)", overflowY: "auto", minHeight: 0,
      }}>{left}</nav>
      <Divider onDrag={delta => apply({ left: sizes.left + delta })} />
      <main aria-label="对话与行动" style={{
        flex: 1, minWidth: 320, display: "flex", flexDirection: "column", minHeight: 0,
        background: "var(--ice-warm-white)",
      }}>{center}</main>
      <Divider onDrag={delta => apply({ right: sizes.right - delta })} />
      <aside aria-label="文章与任务" style={{
        width: sizes.right, flexShrink: 0, background: "var(--ice-surface)",
        borderLeft: "1px solid var(--ice-border)", overflowY: "auto", minHeight: 0,
      }}>{right}</aside>
    </div>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "var(--ice-space-6)", maxWidth: 720, margin: "0 auto" }}>
          <EmptyState title="界面遇到问题" hint="功能数据不受影响；可重试或返回旧版界面（菜单 → 返回旧版）。" />
          <pre style={{
            background: "var(--ice-surface-sunken)", padding: "var(--ice-space-3)",
            borderRadius: "var(--ice-radius-md)", overflowX: "auto", fontSize: "var(--ice-font-size-sm)",
          }}>{String(this.state.error?.stack || this.state.error)}</pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, padding: "6px 16px", cursor: "pointer" }}
          >重试渲染</button>
        </div>
      );
    }
    return this.props.children;
  }
}
