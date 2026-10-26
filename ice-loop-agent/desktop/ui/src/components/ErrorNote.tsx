// 内联错误提示（批次A-03 / B-06 收敛）：统一接入 errorText 映射。
// 已知错误码 → 标题/原因/下一步 + 可展开脱敏诊断；未映射的本地提示保留原文。
// 不自动执行后端 action；重试入口由调用方显式提供。
import * as React from "react";

import { Button } from "./ui";
import { errorDisplay } from "./errorText";

export function ErrorNote({ error, onRetry, retryLabel, note }: {
  error: unknown;
  /** 显式重试入口；仅在映射判定重试有意义（retry !== "none"）时渲染。 */
  onRetry?: () => void;
  retryLabel?: string;
  /** 追加的领域说明（如"输入已保留"），展示在映射文案之后。 */
  note?: string;
}) {
  const [expanded, setExpanded] = React.useState(false);
  if (error == null) return null;
  const display = errorDisplay(error);
  const retryUsable = Boolean(onRetry) && display.retry !== "none";
  return (
    <div role="alert" className="ice-error-note">
      <div className="ice-error-note__title">{display.title}</div>
      {display.detail && <div className="ice-error-note__detail">{display.detail}</div>}
      {display.nextStep && <div className="ice-error-note__next">下一步：{display.nextStep}</div>}
      {note && <div className="ice-error-note__next">{note}</div>}
      {display.action && (
        <div className="ice-error-note__detail">后端建议动作：{display.action}
          {display.recoverable === false ? "（标记为不可自动恢复）" : undefined}</div>
      )}
      <div className="ice-error-note__actions">
        {retryUsable && (
          <Button size="sm" variant="ghost" onClick={onRetry}>{retryLabel ?? "重试"}</Button>
        )}
        <button type="button" className="ice-link-btn" aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起诊断" : "展开诊断"}
        </button>
      </div>
      {expanded && (
        <code className="ice-error-note__diagnostic">{display.diagnostic}</code>
      )}
    </div>
  );
}
