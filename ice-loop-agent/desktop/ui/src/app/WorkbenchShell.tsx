// 三栏创作工作台壳（M2-03）：可拖动分栏、最小宽度、窗口缩小时自适应。
// 布局持久化经 window.localStorage（后续迁到对象级工作区设置）；宽度计算见 paneLayout.ts。
import * as React from "react";

import { Button, EmptyState } from "../components/ui";
import {
  MAX_LEFT, MAX_RIGHT, MIN_LEFT, MIN_RIGHT, PANE_DEFAULTS, fitSizes, normalizeSizes, resizePane,
  type PaneSizes,
} from "./paneLayout";

const STORAGE_KEY = "ice.ui.panes";

function loadSizes(): PaneSizes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeSizes(JSON.parse(raw) as Partial<PaneSizes>) : PANE_DEFAULTS;
  } catch {
    return PANE_DEFAULTS;
  }
}

function Divider({ label, value, min, max, onDrag, onReset }: {
  label: string; value: number; min: number; max: number;
  onDrag: (deltaPx: number) => void; onReset: () => void;
}) {
  const start = React.useRef<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const stop = () => { start.current = null; setDragging(false); };
  return (
    <div
      className="ice-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      data-dragging={dragging || undefined}
      onPointerDown={event => {
        start.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        if (start.current === null) return;
        onDrag(event.clientX - start.current);
        start.current = event.clientX;
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
      onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === "ArrowLeft") { event.preventDefault(); onDrag(-step); }
        else if (event.key === "ArrowRight") { event.preventDefault(); onDrag(step); }
        else if (event.key === "Home" || event.key === "Enter") { event.preventDefault(); onReset(); }
      }}
    />
  );
}

export function WorkbenchShell({ left, center, right }: {
  left: React.ReactNode; center: React.ReactNode; right: React.ReactNode;
}) {
  const [preferred, setPreferred] = React.useState<PaneSizes>(loadSizes);
  const [width, setWidth] = React.useState(0);
  const widthRef = React.useRef(0);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const firstPersist = React.useRef(true);

  // 跟随窗口宽度。ResizeObserver 比 window.resize 更准：不受滚动条和缩放干扰。
  React.useEffect(() => {
    const node = shellRef.current;
    if (!node) return;
    const update = (next: number) => { widthRef.current = next; setWidth(next); };
    update(node.clientWidth);
    const observer = new ResizeObserver(entries => update(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const sizes = React.useMemo(() => fitSizes(preferred, width), [preferred, width]);

  // 只在用户改动后持久化，并防抖；不在 setState 更新函数里做副作用。
  React.useEffect(() => {
    if (firstPersist.current) { firstPersist.current = false; return; }
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred)); }
      catch { /* 无持久化不阻塞 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [preferred]);

  const drag = React.useCallback((side: "left" | "right", deltaPx: number) => {
    setPreferred(previous => resizePane(previous, side, deltaPx, widthRef.current));
  }, []);

  return (
    <div className="ice-shell" ref={shellRef}>
      <nav aria-label="工作区导航" className="ice-pane ice-pane--left" style={{ width: sizes.left }}>
        {left}
      </nav>
      <Divider label="调整导航栏宽度" value={sizes.left} min={MIN_LEFT} max={MAX_LEFT}
               onDrag={delta => drag("left", delta)}
               onReset={() => setPreferred(previous => ({ ...previous, left: PANE_DEFAULTS.left }))} />
      <main aria-label="对话与行动" className="ice-pane--center">{center}</main>
      <Divider label="调整任务栏宽度" value={sizes.right} min={MIN_RIGHT} max={MAX_RIGHT}
               onDrag={delta => drag("right", delta)}
               onReset={() => setPreferred(previous => ({ ...previous, right: PANE_DEFAULTS.right }))} />
      <aside aria-label="文章与任务" className="ice-pane ice-pane--right" style={{ width: sizes.right }}>
        {right}
      </aside>
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
      const detail = String(this.state.error?.stack || this.state.error);
      return (
        <div style={{ padding: "var(--ice-space-6)", maxWidth: 720, margin: "0 auto" }}>
          <EmptyState title="界面遇到问题"
                      hint="已保存的内容不受影响。可重试渲染，或返回稳定界面继续工作。" />
          {/* 堆栈默认折叠：对普通用户是噪音，反馈问题时才需要 */}
          <details style={{ margin: "var(--ice-space-3) 0" }}>
            <summary style={{ cursor: "pointer", color: "var(--ice-text-secondary)" }}>技术详情</summary>
            <pre style={{
              background: "var(--ice-surface-sunken)", padding: "var(--ice-space-3)",
              borderRadius: "var(--ice-radius-md)", overflowX: "auto", fontSize: "var(--ice-font-size-sm)",
            }}>{detail}</pre>
          </details>
          <div style={{ display: "flex", gap: "var(--ice-space-2)" }}>
            <Button variant="primary" onClick={() => this.setState({ error: null })}>重试渲染</Button>
            <Button onClick={() => {
              // 记住选择：下次启动直接进经典界面，不会再撞到同一个错误。
              if (window.ice?.switchUi) void window.ice.switchUi("classic");
              else window.location.assign("ice://app/index.html");
            }}>切换到经典界面</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
