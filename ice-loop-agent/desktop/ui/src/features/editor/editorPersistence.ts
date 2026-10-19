/** One editor owns one write queue. Failed writes must not poison later retries. */
export class EditorPersistence {
  private tail: Promise<unknown> = Promise.resolve();
  private hash = "";
  constructor(private request: <T>(method: string, params: Record<string, unknown>) => Promise<T>,
              private jobId: string) {}

  get baseline() { return this.hash; }
  setBaseline(hash: string) { this.hash = hash; }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.tail.then(write);
    this.tail = result.catch(() => undefined);
    return result;
  }

  saveDraft(content: string) {
    return this.enqueue(() => this.request("articles.editor_draft_save", {
      job_id: this.jobId, content, base_revision: this.hash,
    }));
  }

  saveVersion(body: string) {
    return this.enqueue(async () => {
      const result = await this.request<{ content_hash: string; revision_id: string }>("articles.save", {
        job_id: this.jobId, body, content_hash: this.hash,
      });
      this.hash = result.content_hash;
      // Align recovery with the saved version. Otherwise an old auto-save could be
      // offered as "unsaved" after reopening an already saved article.
      let draftError: string | null = null;
      try {
        await this.request("articles.editor_draft_save", {
          job_id: this.jobId, content: body, base_revision: this.hash,
        });
      } catch (error) { draftError = error instanceof Error ? error.message : String(error); }
      return { ...result, draftError };
    });
  }
}
