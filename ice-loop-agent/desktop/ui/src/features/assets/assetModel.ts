import type { TaskDetail } from '../tasks/taskTypes';
export type AssetCandidate = { candidate_id: string; sha256: string; content_hash: string; review_status: string; source: string };
export type FigureSlot = { slot_id: string; figure_no: number; caption: string; kind: string; position?: string;
  content_hash: string; selected_candidate: string | null; valid: boolean; prompt?: string; candidates: AssetCandidate[] };
export type AssetDetail = TaskDetail & { slots: FigureSlot[]; cover_prompt: string; body_hash: string };
export type ResourceRow = { resource_id: string; content_hash: string; title: string; description?: string; usage?: string;
  width: number; height: number; tags?: string[]; palette?: Array<{ hex: string }> };
export const kindLabel = (kind: string) => ({ cover: '封面', body_real: '真实截图', body_ai: 'AI 插图', body_diagram: '概念图示' } as Record<string, string>)[kind] ?? kind;
export const slotPrompt = (data: AssetDetail, slot: FigureSlot) => slot.kind === 'body_real' ? '' : slot.prompt || (slot.kind === 'cover' ? data.cover_prompt : '') || '';
export const promptParams = (data: AssetDetail, slot: FigureSlot) => ({ job_id: data.job.job_id, figure_no: slot.figure_no, content_hash: slot.content_hash, body_hash: data.body_hash });
export function usableRunKeys(data: AssetDetail): string[] {
  return Object.entries(data.runs ?? {}).filter(([, run]) => ['ok', 'expected_failure_ok'].includes(run.verdict)).map(([key]) => key);
}
export function resourcePage(rows: ResourceRow[], query: string, kind: string, page: number, size = 12) {
  const text = query.trim().toLocaleLowerCase();
  const usage = kind === 'cover' ? 'cover' : kind === 'body_real' ? 'screenshot' : 'illustration';
  const filtered = rows.filter(row => !text || [row.title, row.description, ...(row.tags ?? [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(text))
    .sort((a, b) => Number(b.usage === usage) - Number(a.usage === usage) || a.title.localeCompare(b.title, 'zh-CN'));
  const pages = Math.max(1, Math.ceil(filtered.length / size)), current = Math.max(0, Math.min(pages - 1, page));
  return { rows: filtered.slice(current * size, (current + 1) * size), total: filtered.length, pages, current };
}
