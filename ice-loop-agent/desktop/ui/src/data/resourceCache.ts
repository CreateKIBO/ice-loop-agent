/** In-memory event cache: bounded by entries, estimated UTF-16 bytes and idle TTL. */
export class ResourceCache<T> {
  private entries = new Map<string, { value: T; bytes: number; touched: number }>();
  private bytes = 0;
  constructor(private readonly maxEntries: number, private readonly maxBytes: number,
              private readonly ttlMs: number, private readonly weigh: (value: T) => number,
              private readonly now = Date.now) {}

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private expire() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (now - entry.touched >= this.ttlMs) this.remove(key);
  }
  get(key: string): T | undefined {
    this.expire();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.touched = this.now(); this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T): boolean {
    this.expire(); this.remove(key);
    const bytes = this.weigh(value);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytes || this.maxEntries < 1) return false;
    this.entries.set(key, { value, bytes, touched: this.now() }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    return true;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  stats() { this.expire(); return { entries: this.entries.size, bytes: this.bytes }; }
}
