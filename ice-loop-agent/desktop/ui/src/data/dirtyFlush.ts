/** A navigation may continue only after all pending recovery writes succeed. */
export function createDirtyFlusher(isDirty: (key: string) => boolean) {
  const handlers = new Map<string, () => Promise<void> | void>();
  const failures = new Map<string, string>();
  return {
    registerDirtyFlush(key: string, flush: () => Promise<void> | void) {
      handlers.set(key, flush);
      return () => { if (handlers.get(key) === flush) { handlers.delete(key); failures.delete(key); } };
    },
    async flushAllDirty(): Promise<string[]> {
      const failed: string[] = [];
      for (const [key, flush] of [...handlers]) {
        if (!isDirty(key)) continue;
        try { await flush(); failures.delete(key); }
        catch (error) {
          failed.push(key);
          const shaped=error as {message?:unknown}|null;
          failures.set(key,(typeof shaped?.message==='string'?shaped.message:String(error)).slice(0,2000));
        }
      }
      if (failed.length) {
        const reasons=[...new Set(failed.map(key=>failures.get(key)).filter(Boolean))].slice(0,3).map(reason=>reason!.slice(0,500));
        throw new Error("已取消切换，当前编辑内容已保留。" + reasons.join("；"));
      }
      return [];
    },
    lastFlushFailure: (key: string) => failures.get(key),
  };
}
