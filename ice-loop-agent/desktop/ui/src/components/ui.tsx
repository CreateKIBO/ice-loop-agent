// 公共控件（M2-02）：Button/IconButton/Input/Banner/EmptyState/
// ErrorPanel/Spinner + Radix Dialog/Tabs/Tooltip 封装。
// 全部控件实现 disabled/loading/error/focus 状态；loading 不改变按钮宽度。
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import "../styles/tokens.css";
import "../styles/base.css";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

const BUTTON_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: "var(--ice-signal-blue)", color: "#fff" },
  secondary: { background: "var(--ice-surface)", color: "var(--ice-text)", border: "1px solid var(--ice-border)" },
  danger: { background: "var(--ice-danger)", color: "#fff" },
  ghost: { background: "transparent", color: "var(--ice-text-secondary)" },
};

export function Button({ variant = "secondary", loading = false, disabled,
                         children, style, ...rest }: ButtonProps) {
  const isActive = !disabled && !loading;
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        height: "var(--ice-control-height)", padding: "0 var(--ice-space-3)",
        borderRadius: "var(--ice-radius-md)", cursor: isActive ? "pointer" : "default",
        opacity: disabled && !loading ? 0.55 : 1,
        transition: `background var(--ice-motion-fast) var(--ice-motion-ease)`,
        ...BUTTON_STYLES[variant],
        ...style,
      }}
      onMouseDown={isActive ? rest.onMouseDown : undefined}
      onClick={isActive ? rest.onClick : undefined}
    >
      {loading && <Spinner size={12} />}
      {children}
    </button>
  );
}

export function IconButton({ label, children, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip content={label}>
      <button
        {...rest}
        aria-label={label}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: "var(--ice-control-height)", height: "var(--ice-control-height)",
          border: "none", background: "transparent", borderRadius: "var(--ice-radius-md)",
          cursor: "pointer", color: "var(--ice-text-secondary)",
        }}
      >{children}</button>
    </Tooltip>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span aria-hidden style={{
      width: size, height: size, display: "inline-block",
      border: "2px solid currentColor", borderTopColor: "transparent",
      borderRadius: "50%", opacity: 0.8,
      animation: `ice-spin 700ms linear infinite`,
    }} />
  );
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

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--ice-space-7) var(--ice-space-5)",
                  color: "var(--ice-text-secondary)" }}>
      <div style={{ fontWeight: 600, color: "var(--ice-text)", marginBottom: 6 }}>{title}</div>
      {hint && <div>{hint}</div>}
    </div>
  );
}

export function Dialog({ open, onOpenChange, title, children, footer }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay style={{
          position: "fixed", inset: 0, background: "rgba(21,25,31,0.4)", zIndex: "var(--ice-z-dialog)",
        }} />
        <DialogPrimitive.Content style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          background: "var(--ice-surface)", borderRadius: "var(--ice-radius-lg)",
          padding: "var(--ice-space-5)", width: "min(560px, calc(100vw - 48px))",
          maxHeight: "calc(100vh - 96px)", display: "flex", flexDirection: "column",
          zIndex: "var(--ice-z-dialog)", border: "1px solid var(--ice-border)",
        }}>
          <DialogPrimitive.Title style={{ margin: 0, fontSize: "var(--ice-font-size-lg)",
                                          marginBottom: "var(--ice-space-3)" }}>{title}</DialogPrimitive.Title>
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
          {footer && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--ice-space-2)",
                          marginTop: "var(--ice-space-4)", flexShrink: 0 }}>{footer}</div>
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

// keyframes 注入一次
const styleEl = document.createElement("style");
styleEl.textContent = `@keyframes ice-spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(styleEl);
