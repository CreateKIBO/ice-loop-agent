// v3.16 本篇写作技能：编辑器顶栏“本篇使用”。实现在 features/skills/SkillScope.tsx（与助手会话共用）。
import { SkillScopeChip, type GeneratedSkill, type SkillBinding } from "../skills/SkillScope";

export { SkillPicker, skillLine, type SkillBinding, type SkillPreview } from "../skills/SkillScope";

export function DocumentSkillChip({ documentId, binding, generated }: { documentId: string; binding: SkillBinding | null; generated?: GeneratedSkill[] }) {
  return <SkillScopeChip target={{ document_id: documentId }} saveMethod="documents.skill_binding" binding={binding} generated={generated}
                         noun="本篇" effect="之后的 AI 助手按此生效。" />;
}
