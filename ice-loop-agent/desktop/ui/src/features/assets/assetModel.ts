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

// ---- 批C（2026-10-22）：配图计划总览 / 制作清单的纯推导 ----
// 清单只用已保存的图位数据（jobs.get）与实际读到的参考图；未读的参考列表明确标注，
// 不编造内容，也不为复制清单发起任何模型调用。

export type ChecklistReference = { image: number; role: string; filename: string; title: string };

const ROLE_LABEL: Record<string, string> = { template: '编辑底图', identity: '品牌身份参考', style: '风格参考' };

/** 图位行摘要：图号/用途/位置/提示词是否存在/当前选用是否有效（slot.valid 为准）。 */
export function slotOverviews(data: AssetDetail) {
  return data.slots.map(slot => ({
    figureNo: slot.figure_no, kind: slot.kind, kindText: kindLabel(slot.kind),
    caption: slot.caption, position: slot.position ?? '',
    hasPrompt: slot.kind !== 'body_real' && Boolean(slotPrompt(data, slot)),
    valid: Boolean(slot.valid),
  }));
}

/** C2：可复制的配图制作清单（Markdown 文本）。references 为 null 表示本次未读取该图位的参考列表。 */
export function buildAssetChecklist(data: AssetDetail,
                                    references: (figureNo: number) => ChecklistReference[] | null): string {
  const title = data.article.final_title || data.article.topic;
  const lines: string[] = [
    `# 配图制作清单 · ${title}（${data.article.series}-${String(data.article.episode).padStart(3, '0')}）`,
    '',
    '内容来源：配图工作台当前读取的已保存图位与提示词（未保存的修改不在清单内）。复制本清单不会调用模型，也不会重新生成提示词。',
    '',
  ];
  for (const slot of data.slots) {
    const prompt = slotPrompt(data, slot);
    lines.push(`## 图${slot.figure_no} · ${kindLabel(slot.kind)} · ${slot.caption}${slot.position ? `（位置：${slot.position}）` : ''}`);
    lines.push(`- 当前状态：${slot.valid ? '已有有效图片（已采纳）' : '待配图'}`);
    if (slot.kind === 'body_real') {
      lines.push('- 提示词：真实截图图位，不需要生图提示词');
      lines.push('- 操作说明：按图位位置要求截取真实画面；在配图工作台「导入图片并采纳」，或从内嵌浏览器下载后在下载箱绑定到本图位');
    } else {
      lines.push(prompt ? `- 提示词（已保存版本）：\n\n  ${prompt.split('\n').join('\n  ')}\n`
                        : '- 提示词：尚未准备（打开配图工作台对应图位补充）');
      const refs = references(slot.figure_no);
      if (refs === null) lines.push('- 参考图：（本次未读取该图位的参考列表；请在配图工作台对应图位查看顺序与文件名）');
      else if (refs.length === 0) lines.push('- 参考图：本图位暂无参考图');
      else lines.push(`- 参考图（按顺序上传到 TapNow）：${refs.map(ref => `${ref.image}. ${ROLE_LABEL[ref.role] ?? '参考图'} · ${ref.filename || ref.title}`).join('；')}`);
      lines.push('- 操作说明：在 TapNow 粘贴提示词并按顺序上传参考图生成；生成后的图片回下载箱绑定到本图位（复制提示词不会附带图片）');
    }
    lines.push('');
  }
  lines.push('> 本清单由 ICE Loop Studio 配图工作台生成；图片生成与发布均由你在 TapNow / 公众号后台操作。');
  return lines.join('\n');
}
