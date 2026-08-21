/**
 * Per-session serial ingestion queue (spec §8.3, §13) — `.6` teardown fix.
 *
 * The `session/event` hot path must stay constant-time: it only normalizes
 * and enqueues. A per-session FIFO worker performs the durable work
 * (persisting cursors) strictly in order, so replay, duplicate delivery and
 * concurrent appends can never interleave per session. Writes happen on the
 * domain's single write chain, so durability order across sessions is also
 * total; the queue only guarantees per-session ordering semantics.
 *
 * Teardown ordering:
 *
 *   - The previous `.5` implementation took a snapshot of `chains.values()`
 *     exactly once at the start of `drain()`. Tasks enqueued AFTER the
 *     snapshot but BEFORE the chain returned to quiescence ran their `run()`
 *     outside any awaited barrier; in combination with a parallel
 *     `domain.close()`, those tasks hit a `disposing=true` Domain and were
 *     rejected with `DomainError('closed')`, losing durable work.
 *
 *   - `.6` makes the queue a true barrier:
 *       1. `drain()` flips `draining=true` and rejects further `enqueue()`
 *          with `Error('queue-draining')` (admission gate).
 *       2. The awaiter polls `pending` until it is empty, AND every currently
 *          tracked chain promise has settled. Polling is `queueMicrotask`
 *          scheduled, never a fixed sleep — drain still completes in
 *          constant work, but only once real quiescence is achieved.
 *
 *   - The matching `OutcomeLoopService` disposer (the SOLE owner of the
 *     storage domain) detaches observation FIRST, so no new enqueue can
 *     occur during the drain window in practice. The admission gate is the
 *     second line of defense.
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
    if (this.draining) {
      throw new Error('queue-draining: SessionQueue refuses new tasks after drain() begins')
    }
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
   * enqueued AFTER this call begins are rejected with `Error('queue-draining')`
   * — callers MUST detach any observation/admission source before calling
   * `drain()` (see `OutcomeLoopService` disposer).
   */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    while (this.pending.size > 0 || this.chains.size > 0) {
      const chains = [...this.chains.values()]
      if (chains.length > 0) {
        await Promise.allSettled(chains)
      }
      if (this.pending.size === 0 && this.chains.size === 0) break
      // Yield once so any further microtask-driven `enqueue()` (which the
      // admission gate now refuses) settles its bookkeeping before we
      // re-check; in practice no new enqueue is possible because the gate
      // rejects them.
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
  }

  get isDraining(): boolean {
    return this.draining
  }

  /** Number of sessions with queued work (diagnostics). */
  get load(): number {
    return this.chains.size
  }
}
