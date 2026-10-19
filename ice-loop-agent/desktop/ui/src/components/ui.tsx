// 公共控件（M2-02）：Button/IconButton/Input/Banner/EmptyState/
// ErrorPanel/Spinner + Radix Dialog/Tabs/Tooltip 封装。
// 全部控件实现 disabled/loading/error/focus 状态；loading 不改变按钮宽度。
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { registerToastHost } from './toastHost';

import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/feedback.css";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  /** 紧凑尺寸，用于列表行内操作。 */
  size?: "md" | "sm";
}

export function Button({ variant = "secondary", loading = false, size = "md", disabled,
                         children, className, ...rest }: ButtonProps) {
  // disabled 的按钮浏览器本身不会触发 click，无需再手动屏蔽事件。
  const classes = ["ice-btn", `ice-btn--${variant}`, size === "sm" ? "ice-btn--sm" : "", className ?? ""]
    .filter(Boolean).join(" ");
  return (
    <button
      type="button"
      {...rest}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <Spinner size={12} />}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        {...rest}
        className={["ice-icon-btn", className ?? ""].filter(Boolean).join(" ")}
        aria-label={label}
      >{children}</button>
    </Tooltip>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span aria-hidden className="ice-spinner" style={{ width: size, height: size }} />;
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ style, ...rest }, ref) {
    return (
      <input ref={ref} {...rest} style={{
        height: "var(--ice-control-height)", padding: "0 var(--ice-space-2)",
        border: "1px solid var(--ice-border)", borderRadius: "var(--ice-radius-md)",
        background: "var(--ice-surface)", minWidth: 0,
        ...style,
      }} />
    );
  });

export function Banner({ tone = "info", title, children, actions }: {
  tone?: "info" | "warning" | "danger" | "success";
  title: string; children?: React.ReactNode; actions?: React.ReactNode;
}) {
  const bg = { info: "var(--ice-info-bg)", warning: "var(--ice-warning-bg)",
               danger: "var(--ice-danger-bg)", success: "var(--ice-success-bg)" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} style={{
      background: bg, borderRadius: "var(--ice-radius-lg)", padding: "var(--ice-space-3) var(--ice-space-4)",
      display: "flex", gap: "var(--ice-space-3)", alignItems: "flex-start",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: "block", marginBottom: 2 }}>{title}</strong>
        {children && <div style={{ color: "var(--ice-text-secondary)" }}>{children}</div>}
      </div>
      {actions && <div style={{ display: "flex", gap: "var(--ice-space-2)", flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

export function ErrorPanel({ title, detail, onRetry, onDismiss, retryLabel }: {
  title: string; detail?: string; onRetry?: () => void; onDismiss?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" style={{
      border: "1px solid var(--ice-danger)", borderRadius: "var(--ice-radius-lg)",
      padding: "var(--ice-space-4)", background: "var(--ice-surface)",
      display: "grid", gap: "var(--ice-space-3)",
    }}>
      <strong>{title}</strong>
      {detail && <div style={{ color: "var(--ice-text-secondary)", whiteSpace: "pre-wrap" }}>{detail}</div>}
      <div style={{ display: "flex", gap: "var(--ice-space-2)" }}>
        {onRetry && <Button variant="primary" onClick={onRetry}>{retryLabel ?? "重试"}</Button>}
        {onDismiss && <Button variant="ghost" onClick={onDismiss}>知道了</Button>}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--ice-space-7) var(--ice-space-5)",
                  color: "var(--ice-text-secondary)" }}>
      <div style={{ fontWeight: 600, color: "var(--ice-text)", marginBottom: 6 }}>{title}</div>
      {hint && <div>{hint}</div>}
      {action && <div style={{ marginTop: "var(--ice-space-3)" }}>{action}</div>}
    </div>
  );
}

/** 列表加载占位：保留列表的大致形状，避免内容出现时整块跳动。 */
export function SkeletonRows({ rows = 4, height = 14, gap = 12 }: { rows?: number; height?: number; gap?: number }) {
  return (
    <div aria-hidden style={{ display: "grid", gap, padding: "var(--ice-space-2)" }}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="ice-skeleton" style={{ height, width: `${92 - (index % 3) * 18}%` }} />
      ))}
    </div>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, footer, width = 560, initialFocus, className }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode;
  width?: number;
  /** 打开时聚焦的元素选择器；默认 Radix 会聚焦并全选第一个输入框。 */
  initialFocus?: string;
  className?: string;
}) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const notificationCleanup = React.useRef<(() => void) | undefined>(undefined);
  const notificationRef = React.useCallback((node: HTMLDivElement | null) => {
    notificationCleanup.current?.();
    notificationCleanup.current = node ? registerToastHost(node) : undefined;
  }, []);
  const focusInitial = (event: Event) => {
    const target = initialFocus ? contentRef.current?.querySelector<HTMLElement>(initialFocus) : null;
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ice-dialog-overlay" />
        <DialogPrimitive.Content ref={contentRef} onOpenAutoFocus={focusInitial}
                                 className={'ice-dialog' + (className ? ' ' + className : '')} style={{ width: `min(${width}px, calc(100vw - 48px))` }}
                                 {...(description ? {} : { "aria-describedby": undefined })}>
          <DialogPrimitive.Title style={{ margin: 0, fontSize: "var(--ice-font-size-lg)",
                                          marginBottom: description ? 4 : "var(--ice-space-3)" }}>{title}</DialogPrimitive.Title>
          {description
            ? <DialogPrimitive.Description style={{ margin: "0 0 var(--ice-space-3)", color: "var(--ice-text-secondary)",
                                                    fontSize: "var(--ice-font-size-sm)", lineHeight: 1.6 }}>
                {description}
              </DialogPrimitive.Description>
            : null}
          <div ref={notificationRef} className="ice-dialog-notifications" />
          <div className="ice-dialog-body" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
          {footer && (
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "var(--ice-space-2)",
                          marginTop: "var(--ice-space-4)", flexShrink: 0, flexWrap: "wrap" }}>{footer}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const Tabs = TabsPrimitive.Root;
export const TabsList = TabsPrimitive.List;
export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger value={value} style={{
      padding: "6px var(--ice-space-3)", border: "none", background: "transparent",
      cursor: "pointer", color: "var(--ice-text-secondary)",
      borderBottom: "2px solid transparent",
    }}>
      {children}
    </TabsPrimitive.Trigger>
  );
}
export const TabsContent = TabsPrimitive.Content;

export function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content sideOffset={4} style={{
            background: "var(--ice-ink)", color: "var(--ice-warm-white)",
            padding: "4px 8px", borderRadius: "var(--ice-radius-sm)",
            fontSize: "var(--ice-font-size-sm)", zIndex: "var(--ice-z-dropdown)",
          }}>{content}</TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
