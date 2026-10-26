// 用户可见错误映射（批次1-03）：错误码 → 标题/原因/下一步的可操作文案。
// 原始错误码保留供展开诊断；不回显 Key、请求头或全文敏感内容；未知错误不吞掉。

export interface ErrorCopy {
  title: string;
  /** 原因说明（用户语言，不含敏感字段）。 */
  detail: string;
  /** 建议的下一步动作描述；无通用建议时省略。 */
  nextStep?: string;
  /** 建议的重试语义：safe=可直接重试；manual=需要用户先处理；none=重试无意义。 */
  retry: "safe" | "manual" | "none";
}

/** Read only the message field; never serialize a whole RPC object or headers. */
function messageText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "未提供诊断消息";
}

export function errorCode(error: unknown): string {
  const shape = error as { code?: unknown } | null;
  const explicit = shape && typeof shape.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(shape.code) ? shape.code : null;
  const embedded = messageText(error).match(/\[([A-Z][A-Z0-9_]{1,79})\]/)?.[1];
  return explicit && !["UNKNOWN", "INTERNAL_ERROR", "ENGINE_ERROR", "RPC_ERROR"].includes(explicit)
    ? explicit : embedded ?? explicit ?? "UNKNOWN";
}

export function redactText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "sk-***")
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer ***")
    .replace(/(["']?[\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1"[已隐藏]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@");
}

export function diagnosticText(error: unknown): string {
  const redacted = redactText(messageText(error));
  const clipped = redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
  return `[${errorCode(error)}] ${clipped}`;
}

const KNOWN: Record<string, ErrorCopy> = {
  MODEL_BUDGET_EXCEEDED: {
    title: "模型调用已达上限",
    detail: "本篇或本次会话的模型调用次数已用完，继续生成会失败。",
    nextStep: "查看模型与 Key 设置中的调用预算，并核对当前任务上限，处理后再继续。",
    retry: "manual",
  },
  AUTH_FAILED: {
    title: "模型凭据未配置或已失效",
    detail: "对应供应商的 API Key 缺失、错误或已过期。",
    nextStep: "在设置 → 模型中重新保存该供应商的 Key（保存后无需重启）。",
    retry: "manual",
  },
  MODEL_TIMEOUT: {
    title: "模型请求超时", detail: "本次请求超过总时限，尚未得到完整候选。",
    nextStep: "检查网络与模型状态后再决定是否重新生成；远端已处理的部分仍可能计费。", retry: "manual",
  },
  CONTEXT_LENGTH: {
    title: "资料超过模型输入限制", detail: "当前输入或输出要求超过可用窗口。",
    nextStep: "核对当前模型窗口和输出设置，调整资料安排；不要静默丢弃历史文章。", retry: "manual",
  },
  PARAM_UNSUPPORTED: {
    title: "模型不支持当前参数", detail: "所选模型与当前调用参数不兼容。",
    nextStep: "核对端点、模型及配置后再继续。", retry: "manual",
  },
  MODEL_CAPABILITY_MISMATCH: {
    title: "没有满足要求的模型", detail: "已配置模型不具备当前任务要求的能力。",
    nextStep: "检查模型分工与能力配置，选择满足要求的模型。", retry: "manual",
  },
  CONTENT_REFUSED: {
    title: "模型拒绝了本次请求", detail: "模型没有提供可用内容。",
    nextStep: "审阅请求内容和服务返回说明，再决定如何修改。", retry: "manual",
  },
  NETWORK: {
    title: "网络连接失败",
    detail: "连接或响应读取失败，可能与断网、代理或服务状态有关；不能据此判断远端是否已处理。",
    nextStep: "检查网络后重试；输入和已生成内容都已保留。",
    retry: "safe",
  },
  RATE_LIMIT: {
    title: "请求过于频繁",
    detail: "模型服务暂时限流。",
    nextStep: "等待片刻再重试；输入已保留。",
    retry: "safe",
  },
  SERVER_ERROR: {
    title: "模型服务暂时异常",
    detail: "供应商返回了服务端错误。",
    nextStep: "稍后重试，或切换备用模型。",
    retry: "safe",
  },
  EMPTY_RESPONSE: {
    title: "模型没有返回内容",
    detail: "连接建立但没有收到任何正文。",
    nextStep: "直接重试通常可以恢复；输入已保留。",
    retry: "safe",
  },
  RESPONSE_INCOMPLETE: {
    title: "回复被截断",
    detail: "模型输出没有完整结束就中断了。",
    nextStep: "可以重试，或让模型“继续写完上一段”。",
    retry: "safe",
  },
  CANCELLED: {
    title: "操作已取消",
    detail: "本次操作已停止；远端请求可能仍产生费用。",
    nextStep: "不需要重试时无需处理。",
    retry: "none",
  },
  ACCOUNT_MISMATCH: {
    title: "公众号已切换",
    detail: "该内容属于另一个公众号，当前账号无权查看或修改。",
    nextStep: "请切换回原公众号后继续。",
    retry: "manual",
  },
  REVISION_CONFLICT: {
    title: "内容已被更新",
    detail: "你正在编辑的版本之后已有新的保存，直接覆盖会丢失别人的修改。",
    nextStep: "先保留本地修改，再按当前界面的冲突提示载入最新版本核对。",
    retry: "manual",
  },
  VALIDATION_ERROR: {
    title: "输入不满足要求",
    detail: "请求参数未通过校验（例如字数超限或缺少必填项）。",
    nextStep: "按提示修改输入后重试。",
    retry: "manual",
  },
  NOT_FOUND: {
    title: "内容不存在",
    detail: "对象可能已被删除、归档或属于其他账号。",
    nextStep: "刷新列表并检查当前账号；只有可恢复对象才能通过对应入口找回。",
    retry: "manual",
  },
  PERMISSION_DENIED: {
    title: "没有执行权限",
    detail: "当前账号或当前状态不允许此操作。",
    nextStep: "确认账号与任务状态后重试。",
    retry: "manual",
  },
  STATE_CONFLICT: {
    title: "状态已变化",
    detail: "对象已进入新状态（例如任务已完成或已取消）。",
    nextStep: "刷新查看最新状态后再操作。",
    retry: "manual",
  },
  IDEMPOTENCY_CONFLICT: {
    title: "重复提交冲突",
    detail: "同一操作键已用于不同内容。",
    nextStep: "请勿复用旧请求重试；重新发起操作。",
    retry: "manual",
  },
};

KNOWN.BUDGET_EXCEEDED=KNOWN.MODEL_BUDGET_EXCEEDED;

/** 获取用户文案；未知错误码返回兜底（保留码可展开，不吞掉）。 */
export function errorCopy(error: unknown): ErrorCopy {
  return copyFor(error).copy;
}

function copyFor(error: unknown): { copy: ErrorCopy; mapped: boolean } {
  const code = errorCode(error);
  const known = KNOWN[code];
  if (known) return { copy: known, mapped: true };
  // 消息级关键字兜底：中文引擎消息（无稳定码）常见形态。
  const message = messageText(error);
  if (message.includes("已变化") || message.includes("已更新，请刷新")) {
    return { copy: KNOWN.REVISION_CONFLICT, mapped: true };
  }
  if (message.includes("公众号已切换")) {
    return { copy: KNOWN.ACCOUNT_MISMATCH, mapped: true };
  }
  if (message.includes("已达到上限")) {
    return { copy: KNOWN.MODEL_BUDGET_EXCEEDED, mapped: true };
  }
  return {
    copy: {
      title: "操作未完成",
      detail: "发生未识别的错误；可在展开的诊断信息中查看错误码。",
      nextStep: "先确认操作是否已完成，保留诊断信息；不要反复提交状态未知的操作。",
      retry: "manual",
    },
    mapped: false,
  };
}

/** 内联错误展示（批次A-03）的直接数据源：
 *  有稳定码/已知消息 → 映射文案 + 脱敏诊断 + 后端 action 提示；
 *  未映射的本地校验错误 → 原文展示（比通用兜底更准确），诊断仍可展开。 */
export interface ErrorDisplay {
  title: string;
  detail?: string;
  nextStep?: string;
  retry: ErrorCopy["retry"];
  /** 供展开诊断使用的脱敏文本（含错误码）。 */
  diagnostic: string;
  /** 是否命中已知映射。 */
  mapped: boolean;
  /** 后端附带的建议动作标识（如 open_budget_settings），仅展示不自动执行。 */
  action?: string | null;
  /** 后端标记的可恢复性；undefined 表示后端未提供。 */
  recoverable?: boolean;
}

export function errorDisplay(error: unknown): ErrorDisplay {
  const shape = error as { action?: unknown; recoverable?: unknown } | null;
  const action = shape && typeof shape.action === "string" && shape.action ? redactText(shape.action).slice(0, 200) : null;
  const recoverable = shape && typeof shape.recoverable === "boolean" ? shape.recoverable : undefined;
  const { copy, mapped } = copyFor(error);
  if (mapped) {
    return { ...copy, diagnostic: diagnosticText(error), mapped, action, recoverable };
  }
  // 未映射：原文（截断）作标题，避免把本地校验信息替换成"未识别错误"。
  const message = redactText(messageText(error));
  const clipped = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  return {
    title: clipped === "未提供诊断消息" ? copy.title : clipped,
    nextStep: copy.nextStep,
    retry: copy.retry,
    diagnostic: diagnosticText(error),
    mapped: false,
    action, recoverable,
  };
}
