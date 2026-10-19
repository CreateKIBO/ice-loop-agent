// 事件流纯函数（C1）：按 sequence 合并去重、补缺判断、把一轮对话的真实事件折叠成步骤。
// 不依赖 React / 桥接，便于 node 测试；进度只来自引擎写入的事件，不推算百分比。

export type StreamEvent = {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
  event_id?: string;
};

/** 单个流在内存里保留的事件上限；更早的事件仍在引擎库里，可按游标重取。 */
export const MAX_STREAM_EVENTS = 400;
export const MAX_STREAM_BYTES = 512 * 1024;

/** Bound retained payloads too: a few huge tool results must not defeat the event-count cap. */
export function boundStreamEvents(events: StreamEvent[], maxBytes = MAX_STREAM_BYTES): StreamEvent[] {
  let bytes = 0, start = events.length;
  for (let index = events.length - 1; index >= 0; index--) {
    const size = JSON.stringify(events[index]).length * 2;
    if (bytes + size > maxBytes) break;
    bytes += size; start = index;
  }
  return start === 0 ? events : events.slice(start);
}

export function mergeEvents(existing: StreamEvent[], incoming: StreamEvent[],
                            cap = MAX_STREAM_EVENTS): StreamEvent[] {
  if (!incoming.length) return existing;
  const bySequence = new Map<number, StreamEvent>();
  for (const event of existing) bySequence.set(event.sequence, event);
  let changed = false;
  for (const event of incoming) {
    if (!Number.isInteger(event?.sequence) || event.sequence < 1 || bySequence.has(event.sequence)) continue;
    bySequence.set(event.sequence, event);
    changed = true;
  }
  if (!changed) return existing;
  const merged = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** 引擎按序号升序分页返回，游标前进到本页最大序号；latest 更大说明还有下一页。
 *  不能直接跳到 latest，否则超出单页上限的事件会被永久跳过。 */
export function advanceCursor(cursor: number, events: StreamEvent[]): number {
  let next = cursor;
  for (const event of events) if (event.sequence > next) next = event.sequence;
  return next;
}

export function needsBackfill(cursor: number, latest: number): boolean {
  return Number.isInteger(latest) && latest > cursor;
}

export const PHASE_LABEL: Record<string, string> = {
  reading_context: "读取历史与资料",
  queued: "排队等待",
  waiting_model: "等待模型响应",
  receiving: "模型生成中",
  validating: "校验输出",
  tools: "执行工具",
  saving_candidate: "保存候选稿",
  awaiting_input: "等待你回答",
  ready: "完成",
  failed: "生成失败",
  stopped: "已停止",
  interrupted: "已中断",
};

export const TOOL_LABEL: Record<string, string> = {
  search_articles: "检索旧文", read_article_revision: "读取正文版本",
  get_column_context: "栏目上下文", resolve_brand_rules: "读取品牌规则",
  create_or_update_brief: "更新 brief", propose_topics: "候选题目",
  generate_outline: "生成骨架", propose_article_patch: "选段修改提案",
  propose_image_plan: "图位计划", compose_image_prompt: "配图提示词",
  request_user_input: "向你提问", create_production_task: "创建制作任务",
  prepare_execution: "执行准备", inspect_run_evidence: "查看运行证据",
  bind_asset_candidate: "图位绑定建议", submit_review: "提交审阅",
  prepare_export: "导出预检", list_task_status: "任务状态",
};

export type StepStatus = "done" | "active" | "failed" | "stopped";

export type TurnStep = {
  key: string;
  label: string;
  status: StepStatus;
  at?: string;
  detail?: string;
};

export type TurnProgress = {
  steps: TurnStep[];
  startedAt?: string;
  finished: null | { status: string; phase?: string; errorMessage?: string; candidateId?: string };
  /** 最后一个进行中的步骤（没有则为 null） */
  current: TurnStep | null;
};

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** 把某一轮（turn_id = 助手消息 id）的事件折叠成有序步骤；相邻重复阶段合并。 */
export function turnSteps(events: StreamEvent[], turnId: string): TurnProgress {
  const steps: TurnStep[] = [];
  let startedAt: string | undefined;
  let finished: TurnProgress["finished"] = null;
  const settleActive = (status: StepStatus = "done") => {
    for (const step of steps) if (step.status === "active") step.status = status;
  };
  for (const event of events) {
    const payload = event.payload ?? {};
    if (!turnId || payload.turn_id !== turnId) continue;
    if (event.type === "turn.started") {
      startedAt = str(payload.started_at) || event.created_at;
      const counts = [
        Number(payload.citations) ? `引文 ${payload.citations}` : "",
        Number(payload.references) ? `参考 ${payload.references}` : "",
        Number(payload.documents) ? `资料 ${payload.documents}` : "",
      ].filter(Boolean).join(" · ");
      steps.push({ key: `s${event.sequence}`, label: PHASE_LABEL.reading_context, status: "done",
                   at: event.created_at, detail: counts || undefined });
    } else if (event.type === "turn.phase") {
      const phase = str(payload.phase);
      const last = steps[steps.length - 1];
      if (last && last.key.startsWith("phase:") && last.key.split(":")[1] === phase && last.status === "active") continue;
      settleActive();
      steps.push({ key: `phase:${phase}:${event.sequence}`, label: PHASE_LABEL[phase] ?? phase, status: "active",
                   at: event.created_at, detail: str(payload.model_id) || undefined });
    } else if (event.type === "tool.started") {
      settleActive();
      const tool = str(payload.tool);
      steps.push({ key: `tool:${tool}:${event.sequence}`, label: "执行工具 · " + (TOOL_LABEL[tool] ?? tool),
                   status: "active", at: event.created_at });
    } else if (event.type === "tool.finished") {
      const tool = str(payload.tool);
      const open = [...steps].reverse().find(step => step.status === "active" && step.key.startsWith(`tool:${tool}:`));
      const ok = str(payload.status) === "succeeded";
      if (open) {
        open.status = ok ? "done" : "failed";
        if (!ok) open.detail = str(payload.status) || undefined;
      }
    } else if (event.type === "turn.finished") {
      const status = str(payload.status);
      const phase = str(payload.phase);
      finished = { status, phase: phase || undefined, errorMessage: str(payload.error_message) || undefined,
                   candidateId: str(payload.candidate_id) || undefined };
      if (status === "completed") {
        settleActive();
        const label = phase === "awaiting_input" ? PHASE_LABEL.awaiting_input : PHASE_LABEL.ready;
        steps.push({ key: `end:${event.sequence}`, label, status: "done", at: event.created_at });
      } else {
        const terminal: StepStatus = status === "stopped" ? "stopped" : "failed";
        settleActive(terminal);
        steps.push({ key: `end:${event.sequence}`, label: PHASE_LABEL[status] ?? status, status: terminal,
                     at: event.created_at, detail: finished.errorMessage });
      }
    }
  }
  const current = [...steps].reverse().find(step => step.status === "active") ?? null;
  return { steps, startedAt, finished, current };
}

/** 引擎事件不可用时（旧引擎/事件写入失败）退回到消息元数据里的阶段。 */
export function phaseFromMetadata(metadata: unknown): { phase: string; label: string; startedAt?: string } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const progress = (metadata as { progress?: unknown }).progress;
  if (typeof progress === "string") return progress ? { phase: progress, label: PHASE_LABEL[progress] ?? progress } : null;
  if (!progress || typeof progress !== "object") return null;
  const phase = str((progress as Record<string, unknown>).phase);
  if (!phase) return null;
  return { phase, label: PHASE_LABEL[phase] ?? phase,
           startedAt: str((progress as Record<string, unknown>).started_at) || undefined };
}

/** 最近一条工具/轮次结束事件的序号：行动卡据此立即刷新，而不是等下一个轮询周期。 */
export function toolSignal(events: StreamEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type.startsWith("tool.") || event.type === "turn.finished") return event.sequence;
  }
  return 0;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
