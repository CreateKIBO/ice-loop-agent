/** One heavy image request at a time. Cancelling UI cannot pretend server IO stopped. */
export class ImageQueue {
  private active = false;
  private waiting: Array<{ start: () => void }> = [];
  get pending() { return this.waiting.length; }
  get inFlight() { return Number(this.active); }
  run<T>(read: () => Promise<T>, signal: AbortSignal, original = false): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('图片读取已取消', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      let started = false, settled = false;
      const finish = (value: T) => { if (!settled) { settled = true; resolve(value); } };
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      const abort = () => {
        if (!started) this.waiting = this.waiting.filter(row => row !== entry);
        fail(new DOMException('图片读取已取消', 'AbortError'));
        if (!started) signal.removeEventListener('abort', abort);
      };
      const entry = { start: () => {
        started = true; this.active = true;
        void Promise.resolve().then(() => {
          if (signal.aborted) throw new DOMException('图片读取已取消', 'AbortError');
          return read();
        }).then(finish, fail).finally(() => {
          signal.removeEventListener('abort', abort);
          this.active = false; this.next();
        });
      } };
      signal.addEventListener('abort', abort, { once: true });
      if (original) this.waiting.unshift(entry); else this.waiting.push(entry);
      this.next();
    });
  }
  private next() { if (!this.active) this.waiting.shift()?.start(); }
}
export const imageQueue = new ImageQueue();
