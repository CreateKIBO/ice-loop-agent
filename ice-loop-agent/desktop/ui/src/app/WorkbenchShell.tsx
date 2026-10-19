// Docked panes on large windows; one preserved surface at a time in compact windows.
import * as React from "react";

import { Button, EmptyState } from "../components/ui";
import { PaneActivity } from "./PaneActivity";
import {
  MAX_LEFT, MAX_RIGHT, MIN_LEFT, MIN_RIGHT, PANE_DEFAULTS, normalizeSizes, normalizeVisibility,
  resolveLayout, resizeVisiblePane, type CompactPane, type PaneSizes, type PaneVisibility,
} from "./paneLayout";

const STORAGE_KEY = "ice.ui.panes";
const VISIBILITY_KEY = "ice.ui.panels";

function loadVisibility(): PaneVisibility {
  try { return normalizeVisibility(JSON.parse(window.localStorage.getItem(VISIBILITY_KEY) || "null")); }
  catch { return { left: true, right: true }; }
}

function loadSizes(): PaneSizes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeSizes(JSON.parse(raw) as Partial<PaneSizes>) : PANE_DEFAULTS;
  } catch {
    return PANE_DEFAULTS;
  }
}

function Divider({ label, value, min, max, onDrag, onReset, hidden }: {
  label: string; value: number; min: number; max: number;
  onDrag: (deltaPx: number) => void; onReset: () => void; hidden?: boolean;
}) {
  const start = React.useRef<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const stop = () => { start.current = null; setDragging(false); };
  return (
    <div
      className="ice-divider"
      hidden={hidden}
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
      onLostPointerCapture={stop}
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

export function WorkbenchShell({ left, center, right, navigationKey = "" }: {
  left: React.ReactNode; center: React.ReactNode; right: React.ReactNode; navigationKey?: string;
}) {
  const [preferred, setPreferred] = React.useState<PaneSizes>(loadSizes);
  const [docked, setDocked] = React.useState<PaneVisibility>(loadVisibility);
  const [selected, setSelected] = React.useState<CompactPane>("center");
  const [width, setWidth] = React.useState(0);
  const widthRef = React.useRef(0);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const centerRef = React.useRef<HTMLElement>(null);
  const lastDocked = React.useRef<PaneVisibility>({ left: true, right: true });
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

  const layout = resolveLayout(preferred, width, docked, selected);
  const { sizes, compact } = layout;

  React.useEffect(() => {
    try { window.localStorage.setItem(VISIBILITY_KEY, JSON.stringify(docked)); }
    catch { /* Storage can be disabled; layout remains usable. */ }
  }, [docked]);

  // All panes stay mounted: changing the visible surface must not discard a draft, a filter or a request.
  React.useEffect(() => {
    setSelected("center");
  }, [navigationKey, compact]);
  React.useLayoutEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (focused?.closest("[hidden].ice-pane, [hidden].ice-pane--center")) centerRef.current?.focus();
  }, [layout.left, layout.right, layout.center]);

  const toggle = (side: "left" | "right") => {
    if (compact) setSelected(previous => previous === side ? "center" : side);
    else setDocked(previous => ({ ...previous, [side]: !previous[side] }));
  };
  const focusWriting = () => {
    if (compact) setSelected("center");
    else if (docked.left || docked.right) {
      lastDocked.current = docked;
      setDocked({ left: false, right: false });
    } else setDocked(lastDocked.current);
  };

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
    setPreferred(previous => resizeVisiblePane(previous, side, deltaPx, widthRef.current, docked));
  }, [docked]);

  return (
    <div className="ice-shell" ref={shellRef} data-compact={compact || undefined}
         onKeyDown={event => {
           if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && compact && selected !== "center"
               && !(event.target as HTMLElement).closest('[role="dialog"], [role="menu"], [role="listbox"]')) {
             event.preventDefault(); setSelected("center");
           }
         }}>
      <div className="ice-shell-toolbar" role="group" aria-label="工作区布局">
        <Button size="sm" variant="ghost" aria-controls="ice-navigation-pane" aria-expanded={layout.left}
                aria-pressed={layout.left} onClick={() => toggle("left")}>
          <PaneIcon side="left" />会话与草稿
        </Button>
        <span className="ice-shell-toolbar__context">{compact ? "窄窗口 · 单面板" : "创作工作台"}</span>
        <Button size="sm" variant="ghost" aria-controls="ice-writing-pane"
                aria-pressed={compact ? layout.center : !docked.left && !docked.right} onClick={focusWriting}>
          {compact ? "写作区" : docked.left || docked.right ? "专注写作" : "恢复侧栏"}
        </Button>
        <Button size="sm" variant="ghost" aria-controls="ice-task-pane" aria-expanded={layout.right}
                aria-pressed={layout.right} onClick={() => toggle("right")}>
          <PaneIcon side="right" />任务与资料
        </Button>
      </div>
      <div className="ice-shell__body">
      <nav id="ice-navigation-pane" aria-label="工作区导航" className="ice-pane ice-pane--left"
           hidden={!layout.left} inert={!layout.left} style={{ width: sizes.left }}>
        <PaneActivity.Provider value={layout.left}>{left}</PaneActivity.Provider>
      </nav>
      <Divider label="调整导航栏宽度" value={sizes.left} min={MIN_LEFT} max={MAX_LEFT}
               hidden={compact || !layout.left}
               onDrag={delta => drag("left", delta)}
               onReset={() => setPreferred(previous => ({ ...previous, left: PANE_DEFAULTS.left }))} />
      <main id="ice-writing-pane" ref={centerRef} tabIndex={-1} aria-label="对话与行动" className="ice-pane--center"
            hidden={!layout.center} inert={!layout.center}>{center}</main>
      <Divider label="调整任务栏宽度" value={sizes.right} min={MIN_RIGHT} max={MAX_RIGHT}
               hidden={compact || !layout.right}
               onDrag={delta => drag("right", delta)}
               onReset={() => setPreferred(previous => ({ ...previous, right: PANE_DEFAULTS.right }))} />
      <aside id="ice-task-pane" aria-label="文章与任务" className="ice-pane ice-pane--right"
             hidden={!layout.right} inert={!layout.right} style={{ width: sizes.right }}>
        <PaneActivity.Provider value={layout.right}>{right}</PaneActivity.Provider>
      </aside>
      </div>
    </div>
  );
}

function PaneIcon({ side }: { side: "left" | "right" }) {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="2.5" y="3" width="15" height="14" rx="2" />
    <path d={side === "left" ? "M7.5 3v14" : "M12.5 3v14"} />
  </svg>;
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
