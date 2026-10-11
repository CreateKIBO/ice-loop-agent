/** A navigation may continue only after all pending recovery writes succeed. */
export function createDirtyFlusher(isDirty: (key: string) => boolean) {
  const handlers = new Map<string, () => Promise<void> | void>();
  const failures = new Map<string, string>();
  return {
    registerDirtyFlush(key: string, flush: () => Promise<void> | void) {
      handlers.set(key, flush);
      return () => { if (handlers.get(key) === flush) handlers.delete(key); };
    },
    async flushAllDirty(): Promise<string[]> {
      const failed: string[] = [];
      for (const [key, flush] of [...handlers]) {
        if (!isDirty(key)) continue;
        try { await flush(); failures.delete(key); }
        catch (error) {
          failed.push(key);
          failures.set(key, error instanceof Error ? error.message : String(error));
        }
      }
      if (failed.length) {
        throw new Error("工作草稿保存失败，已取消切换以保留编辑内容。请重试：" + failed.join("、"));
      }
      return [];
    },
    lastFlushFailure: (key: string) => failures.get(key),
  };
}
