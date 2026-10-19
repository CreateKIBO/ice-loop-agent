import type { ChatPage } from '../../data/workbenchResponses';

export const MESSAGE_WINDOW = 40;
export const CANDIDATE_WINDOW = 3;
export type HistoryPosition = { before_message_id: string } | { after_message_id: string };
export type CandidatePosition = { before_candidate_id: string } | { after_candidate_id: string };

export function messagePosition(page: ChatPage | undefined, direction: 'older' | 'newer'): HistoryPosition | null {
  if (direction === 'older' && page?.has_older && page.oldest_id) return { before_message_id: page.oldest_id };
  if (direction === 'newer' && page?.has_newer && page.newest_id) return { after_message_id: page.newest_id };
  return null;
}

// Estimate only; actual Markdown heights are measured by ResizeObserver. Keep
// estimates modest so a single large reply does not hide the following rows.
export function estimateMessage(content: string): number {
  return Math.min(1400, 100 + Math.ceil(content.length / 50) * 24);
}
