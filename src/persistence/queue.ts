/**
 * Per-session serial ingestion queue (spec §8.3, §13).
 *
 * The `session/event` hot path must stay constant-time: it only normalizes
 * and enqueues. A per-session FIFO worker performs the durable work
 * (persisting cursors) strictly in order, so replay, duplicate delivery and
 * concurrent appends can never interleave per session. Writes happen on the
 * domain's single write chain, so durability order across sessions is also
 * total; the queue only guarantees per-session ordering semantics.
 */

export interface QueueTask {
  readonly sessionId: string
  readonly run: () => Promise<void>
}

export class SessionQueue {
  private readonly chains = new Map<string, Promise<void>>()
  private draining = false
  private readonly pending = new Map<string, number>()

  /** Enqueue one task for a session; runs serially with that session's tasks. */
  enqueue(task: QueueTask): void {
    const previous = this.chains.get(task.sessionId) ?? Promise.resolve()
    this.pending.set(task.sessionId, (this.pending.get(task.sessionId) ?? 0) + 1)
    const next = previous
      .catch(() => {
        // A failed task must not poison the chain; the caller owns error handling.
      })
      .then(async () => {
        try {
          await task.run()
        } finally {
          const remaining = (this.pending.get(task.sessionId) ?? 1) - 1
          if (remaining <= 0) {
            this.pending.delete(task.sessionId)
            this.chains.delete(task.sessionId)
          } else {
            this.pending.set(task.sessionId, remaining)
          }
        }
      })
    this.chains.set(task.sessionId, next)
  }

  /**
   * Wait until every accepted task has settled (drain on disposal). Tasks
   * accepted after this call begins are included in the returned promise.
   */
  async drain(): Promise<void> {
    this.draining = true
    const chains = [...this.chains.values()]
    await Promise.allSettled(chains)
  }

  get isDraining(): boolean {
    return this.draining
  }

  /** Number of sessions with queued work (diagnostics). */
  get load(): number {
    return this.chains.size
  }
}
