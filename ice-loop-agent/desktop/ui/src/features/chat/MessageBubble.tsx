import * as React from "react";
import { motion, useMotionValue } from "motion/react";
import { useActivityReducedMotion } from "../../components/ActivityRail";
import { ErrorNote } from "../../components/ErrorNote";
import {diagnosticText} from "../../components/errorText";
import { Button } from "../../components/ui";
import { CopyButton } from "../../components/CopyButton";
import { MarkdownContent } from "../../components/MarkdownContent";
import type { ChatMessage } from "../../data/workbenchResponses";

import { tokenReceipt } from "./tokenReceipt";

const END_NOTE: Record<string, string> = {
  failed: "这条回复未能完成，可重试此回复；原记录保留",
  stopped: "已停止生成",
  interrupted: "应用关闭时中断，内容可能不完整",
};

export function MessageBubble({ row, animateIn, highlighted = false, onReuse, onRetry, retryDisabled=false }: {
  row: ChatMessage; animateIn: boolean; highlighted?: boolean; onReuse: () => void;onRetry?:()=>void;retryDisabled?:boolean;
}) {
  const isUser = row.role === "user";
  const reduced = useActivityReducedMotion();
  const entering = animateIn && !reduced;
  // 第28轮：入场方向改为"从输入框升起"（用户消息 14px、助手回复 6px），不再左右横移。
  const x = useMotionValue(0);
  const y = useMotionValue(entering ? (isUser ? 14 : 6) : 0), opacity = useMotionValue(entering ? 0 : 1);
  const emptyStreaming = !row.content && row.status === "streaming";
  React.useLayoutEffect(() => {
    if (!emptyStreaming && reduced) {
      x.stop(); y.stop(); opacity.stop();
      x.set(0); y.set(0); opacity.set(1);
    }
  }, [x, y, opacity, reduced, emptyStreaming]);
  const failure=!isUser&&row.status==='failed'?{code:row.metadata?.error_code,message:row.metadata?.error_message??row.metadata?.error??row.content}:null;
  const preflight = !isUser ? tokenReceipt(row.metadata?.input_preflight) : null;
  if (emptyStreaming) return null; // 空的生成中消息由打字指示代替
  return (
    <motion.div initial={entering ? { opacity: 0, y: isUser ? 14 : 6, x: 0 } : false}
                animate={{ opacity: 1, y: 0, x: 0 }} transition={{ duration: isUser ? 0.24 : 0.2, ease: [0.2, 0, 0, 1] }}
                className={"ice-message" + (isUser ? " ice-message--user" : "") + (highlighted ? " ice-message--find-hit" : "")}
                style={{ x, y, opacity, display: "grid", gap: 4, justifyItems: isUser ? "end" : "start", minWidth: 0 }}>
      <span className="ice-message__speaker">{isUser ? "你" : "创作助手"}</span>
      <div style={{
        // 第24轮：助手回复限制舒适行宽，宽屏/专注模式下不再铺满整行。
        maxWidth: isUser ? "min(640px, 92%)" : "min(var(--ice-reading-max), 100%)", minWidth: 0, boxSizing: "border-box",
        width: isUser ? undefined : "100%", padding: "var(--ice-space-2) var(--ice-space-3)",
        borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px", whiteSpace: isUser ? "pre-wrap" : "normal", overflowWrap: "anywhere",
        // 写作岛是白底：助手气泡改为浅底 + 轻描边，与用户的蓝底气泡区分，不再白上叠白。
        lineHeight: 1.65, background: isUser ? "var(--ice-info-bg)" : "var(--ice-surface-muted)",
        border: `1px solid ${isUser ? "transparent" : "var(--ice-border-subtle)"}`,
        boxShadow: "none",
      }}>
        {failure?<p style={{margin:0}}>生成未完成，原需求与已有稿件保留。</p>:isUser ? row.content : <MarkdownContent text={row.content} />}
        {row.status === "streaming" && <span className="ice-caret" aria-hidden />}
      </div>
      {row.content && row.status !== "streaming" && <div className="ice-message__actions">
        <CopyButton text={failure?diagnosticText(failure):row.content} label={failure?"复制诊断":"复制消息"} />
        {isUser && <Button variant="ghost" size="sm" onClick={onReuse}>再次使用</Button>}
      </div>}
      {failure&&<ErrorNote error={failure} />}
      {!isUser&&['failed','stopped','interrupted'].includes(row.status)&&onRetry&&<div className="ice-message__retry"><Button size="sm" disabled={retryDisabled} onClick={onRetry}>重试此回复</Button><p className="ice-clarification__hint">将按原需求与引用新建一条回复，使用当前可用模型配置；这会重新调用模型。</p></div>}
      {preflight&&<details className="ice-context-receipt"><summary>{preflight.summary}</summary><p>{preflight.detail}</p></details>}
      {!isUser && <InputContextReceipt value={row.metadata?.input_manifest} />}
      {END_NOTE[row.status] && (
        <span style={{ fontSize: "var(--ice-font-size-sm)",
                       color: row.status === "failed" ? "var(--ice-danger)" : "var(--ice-text-secondary)" }}>
          {END_NOTE[row.status]}
        </span>
      )}
    </motion.div>
  );
}

function InputContextReceipt({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null;
  const data = value as { version?: number; text_characters?: number; history_sources?: unknown };
  if (data.version !== 1 || !Array.isArray(data.history_sources) || !Number.isSafeInteger(data.text_characters)) return null;
  const sources = data.history_sources.filter((row): row is { title_count: number; full_body_count: number } =>
    row && typeof row === 'object' && Number.isSafeInteger(row.title_count) && row.title_count >= 0 &&
    Number.isSafeInteger(row.full_body_count) && row.full_body_count >= 0);
  if (!sources.length) return null;
  const titles = sources.reduce((total, row) => total + row.title_count, 0);
  const bodies = sources.reduce((total, row) => total + row.full_body_count, 0);
  return <details className="ice-context-receipt">
    <summary>写作依据 · {titles.toLocaleString()} 个历史标题 · {bodies} 篇全文</summary>
    <p>历史标题完整保留，前文按所选期号读取。标题表采用紧凑格式，正文没有截断。</p>
    <p>本轮初始请求含 {data.text_characters!.toLocaleString()} 个文本字符（含系统要求、对话与资料）。字符数不等同于 Token，模型窗口仍以供应商实际限制为准。</p>
  </details>;
}

