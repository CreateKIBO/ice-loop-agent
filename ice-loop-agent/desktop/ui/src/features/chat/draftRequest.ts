// v3.11：讨论 → 写初稿 的显示条件与请求文字（纯函数，便于测试）。
import type { ChatMessage } from "../../data/workbenchResponses";

export const DRAFT_FROM_DISCUSSION =
  "请根据我们以上的讨论结果，写出完整初稿。讨论中已经确定的选题、读者、角度、结构和要点直接采用，不要再重复提问；"
  + "仍不确定的地方按合理默认处理，并在回复里用一两句话说明你的取舍。";

/** 只在“最新一条、已完成、讨论模式、没有待答问题”的助手回复下显示。 */
export function canDraftFrom(row: ChatMessage, latestAssistantId: string | undefined, pendingQuestionId: string | undefined) {
  const meta = row.metadata ?? {};
  return row.role === "assistant" && row.status === "completed" && row.id === latestAssistantId
    && (meta.mode ?? "discuss") === "discuss" && row.id !== pendingQuestionId && Boolean(row.content?.trim());
}

export function draftRequestText(extra: string) {
  const more = extra.trim();
  return more ? `${DRAFT_FROM_DISCUSSION}\n补充要求：${more}` : DRAFT_FROM_DISCUSSION;
}
