/** Account/thread-scoped, bounded input recovery. A draft never sends itself. */
export const COMPOSER_MODES = ["discuss", "draft", "edit", "images"] as const;
export type ComposerMode = typeof COMPOSER_MODES[number];
export type ComposerDraft = { text: string; mode: ComposerMode };

// One bounded handoff survives a view change even if localStorage is unavailable.
// Peek is repeatable because React StrictMode may run the state initializer twice.
let staged: { key: string; draft: ComposerDraft } | null = null;
export function stageComposerDraft(account: string, conversation: string, draft: ComposerDraft) {
  if (!validMode(draft.mode) || draft.text.length > 50000) throw Error('创作要求过长或模式无效');
  staged = { key: composerKey(account, conversation), draft: { ...draft } };
}
export function peekStagedComposerDraft(account: string, conversation: string): ComposerDraft | null {
  return staged?.key === composerKey(account, conversation) ? { ...staged.draft } : null;
}
export function acknowledgeStagedComposerDraft(account: string, conversation: string) {
  if (staged?.key === composerKey(account, conversation)) staged = null;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const EMPTY: ComposerDraft = { text: "", mode: "discuss" };
const PREFIX = "ice.composer.v2:";
const MAX_RECORDS = 60;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export const composerKey = (account: string, conversation: string) => PREFIX + JSON.stringify([account, conversation]);
export const validMode = (value: unknown): value is ComposerMode => COMPOSER_MODES.includes(value as ComposerMode);

function decode(raw: string | null, account: string, conversation: string, now: number) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 2 || value.account !== account || value.conversation !== conversation
        || typeof value.text !== "string" || value.text.length > 50000 || !validMode(value.mode)
        || !Number.isFinite(value.updatedAt) || value.updatedAt > now + 60000 || now - value.updatedAt > MAX_AGE) return null;
    return value as ComposerDraft & { updatedAt: number };
  } catch { return null; }
}

export function loadComposerDraft(storage: DraftStorage, account: string, conversation: string, now = Date.now()): ComposerDraft {
  try {
    const value = decode(storage.getItem(composerKey(account, conversation)), account, conversation, now);
    return value ? { text: value.text, mode: value.mode } : { ...EMPTY };
  } catch { return { ...EMPTY }; }
}

export function saveComposerDraft(storage: DraftStorage, account: string, conversation: string, draft: ComposerDraft, now = Date.now()): boolean {
  try {
    if (!validMode(draft.mode) || draft.text.length > 50000) return false;
    const key = composerKey(account, conversation);
    if (!draft.text && draft.mode === "discuss") storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: 2, account, conversation, ...draft, updatedAt: now }));
    // Prune our index only; no storage.clear() or unrelated-key enumeration.
    let index: Array<{ key: string; at: number }> = [];
    try {
      const parsed = JSON.parse(storage.getItem(PREFIX + "index") ?? "[]");
      if (Array.isArray(parsed)) index = parsed.filter(row => row && typeof row.key === "string"
        && row.key.startsWith(PREFIX + "[") && Number.isFinite(row.at));
    } catch { /* Rebuild a damaged index without touching any unrelated data. */ }
    index = index.filter(row => row.key !== key);
    if (draft.text || draft.mode !== "discuss") index.push({ key, at: now });
    index.sort((a, b) => b.at - a.at);
    const keep = index.filter((row, i) => {
      if (i < MAX_RECORDS && now - row.at <= MAX_AGE) return true;
      storage.removeItem(row.key); return false;
    });
    storage.setItem(PREFIX + "index", JSON.stringify(keep));
    return true;
  } catch { return false; }
}

export function appendComposerText(current: string, extra: string): string {
  return current.trim() ? current + "\n\n" + extra : extra;
}

export function shouldSendKey(event: { key: string; shiftKey: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number }, composing: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey
    && !composing && !event.isComposing && event.keyCode !== 229;
}

export const mayClearAcknowledgedInput = (submittedRevision: number, currentRevision: number, submittedScope: string, currentScope: string) =>
  submittedRevision === currentRevision && submittedScope === currentScope;
