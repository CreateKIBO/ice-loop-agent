// v3.17 会话技能：助手会话里可选主技能与辅助技能；之后发出的消息按“本会话 → 会话系列 → 公众号”解析。
import { SkillScopeChip } from "../skills/SkillScope";

export function ConversationSkillChip({ conversationId }: { conversationId: string }) {
  return <SkillScopeChip target={{ conversation_id: conversationId }} saveMethod="skills.conversation_binding" binding={null}
                         noun="本会话" effect="之后在这个会话里发出的消息按此写作；存为文章时一并带到文章上。" />;
}
