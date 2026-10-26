/** Proposal recovery writes never create an article revision. */
export type ReviewDecision = { op_index: number; decision: "accept" | "reject" | "new_text"; text?: string };
export type ReviewDraft = { version: number; decisions: ReviewDecision[]; updated_at: string };
type Entry = { baseHash: string; version: number; items: Record<number, ReviewDecision>; sequence: number; saved: number; retired?: string };
type Save = (id: string, baseHash: string, version: number, decisions: ReviewDecision[]) => Promise<ReviewDraft>;
export class ReviewDraftPersistence {
  private entries = new Map<string, Entry>();
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private generation = 0;
  state: "saved" | "dirty" | "saving" | "error" = "saved";
  error: string | null = null;
  constructor(private save: Save) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.generation;
  private notify() { this.generation++; this.listeners.forEach(listener => listener()); }
  get dirty() { return [...this.entries.values()].some(entry => entry.sequence !== entry.saved || Boolean(entry.retired && Object.keys(entry.items).length)); }
  install(id: string, baseHash: string, draft: ReviewDraft | null) {
    const previous = this.entries.get(id);
    if (previous && (previous.sequence !== previous.saved || previous.version >= (draft?.version ?? 0))) return;
    // Clean decisions are durable in SQLite; do not retain every previously visited proposal.
    for (const [otherId, entry] of this.entries) {
      if (otherId !== id && !entry.retired && entry.sequence === entry.saved) this.entries.delete(otherId);
    }
    this.entries.set(id, { baseHash, version: draft?.version ?? 0,
      items: Object.fromEntries((draft?.decisions ?? []).map(item => [item.op_index, item])), sequence: 0, saved: 0 });
    this.notify();
  }
  /** Reload is explicit: wait for in-flight writes, then replace only after a successful read. */
  async settle() { clearTimeout(this.timer); await this.tail; }
  replace(id: string, baseHash: string, draft: ReviewDraft | null) {
    this.entries.delete(id); this.install(id, baseHash, draft);
    this.error = null; this.state = this.dirty ? "dirty" : "saved"; this.notify();
  }
  retire(id: string, status: string) {
    let entry = this.entries.get(id);
    if (!entry) { entry = { baseHash: "", version: 0, items: {}, sequence: 0, saved: 0 }; this.entries.set(id, entry); }
    entry.retired = status;
    this.notify();
  }
  retiredRecords() { return [...this.entries].filter(([, entry]) => entry.retired).map(([id, entry]) => ({ id, status: entry.retired!, items: entry.items })); }
  version(id: string) { return this.entries.get(id)?.version ?? 0; }
  decisions(id: string) { return this.entries.get(id)?.items ?? {}; }
  edit(id: string, decision: ReviewDecision) {
    const entry = this.entries.get(id);
    if (!entry || entry.retired) throw Error("审阅草稿尚未读取，请稍后重试");
    entry.items = { ...entry.items, [decision.op_index]: decision }; entry.sequence++;
    this.state = "dirty"; this.error = null; this.notify();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 600);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const run = async () => {
      if (!this.dirty) return;
      this.state = "saving"; this.error = null; this.notify();
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          for (const [id, entry] of this.entries) {
            if (entry.retired || entry.saved === entry.sequence) continue;
            const sequence = entry.sequence;
            const draft = await this.save(id, entry.baseHash, entry.version, Object.values(entry.items));
            entry.version = draft.version; entry.saved = sequence;
          }
          if (this.retiredRecords().some(record => Object.keys(record.items).length)) {
            throw Error("提案已在别处处理，本地审阅记录仍保留。请核对或复制后明确移除本地记录，再离开页面。");
          }
          if (!this.dirty) { this.state = "saved"; this.notify(); return; }
        }
        throw Error("审阅决定仍在修改，请稍后再切换；当前输入已保留。");
      } catch (error) {
        this.state = "error"; this.error = error instanceof Error ? error.message : String(error); this.notify(); throw error;
      }
    };
    const pending = this.tail.then(run, run); this.tail = pending.catch(() => undefined); return pending;
  }
  forget(id: string) { this.entries.delete(id); if (!this.dirty) { this.state = "saved"; this.error = null; } this.notify(); }
  cancelTimer() { clearTimeout(this.timer); }
}
export function reviewDecisionCounts(total: number, decisions: Record<number, ReviewDecision>) {
  const counts = { accept: 0, reject: 0, new_text: 0, undecided: 0 };
  for (let index = 0; index < total; index++) {
    const decision = decisions[index]; counts[decision?.decision ?? "undecided"]++;
  }
  return counts;
}
