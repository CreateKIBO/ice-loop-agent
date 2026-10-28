// Reading time belongs to a notification ID, even when its portal remounts.
// This object owns no timer or subscription; the visible card owns those.
export class ToastLifetime {
  private left: number;
  private activeSince: number | null = null;

  constructor(duration: number, private readonly now = () => performance.now()) {
    this.left = duration;
  }

  remaining(): number {
    return Math.max(0, this.left - (this.activeSince === null ? 0 : this.now() - this.activeSince));
  }

  resume(): number {
    if (this.activeSince === null) this.activeSince = this.now();
    return this.remaining();
  }

  pause(): void {
    this.left = this.remaining();
    this.activeSince = null;
  }
}
