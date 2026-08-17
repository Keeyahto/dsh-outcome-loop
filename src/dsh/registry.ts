/**
 * Per-session fact registry (spec §8.3, §13): the in-memory derived index
 * consumed by verification and cost bridges. Rebuildable from the canonical
 * session log — it is never the authority.
 */

import { appendFact, boundedFacts } from '../domain/aggregate.ts'
import type { SessionFact, SessionFactLog } from '../domain/types.ts'
import { createExtractorState, normalizeEvent, type ExtractorState } from './events.ts'

export const FACT_RETENTION_PER_KIND = 64

interface SessionState {
  log: SessionFactLog
  extractor: ExtractorState
  highWater: number
}

export class FactRegistry {
  private readonly sessions = new Map<string, SessionState>()

  /** Ensure a session entry exists; returns its current high-water seq. */
  private ensure(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        log: { sessionId, facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 },
        extractor: createExtractorState(),
        highWater: -1,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** Seed the high-water mark from a durable cursor (restart resume). */
  seedCursor(sessionId: string, lastSeq: number): void {
    const state = this.ensure(sessionId)
    state.highWater = Math.max(state.highWater, lastSeq)
  }

  /** Highest seq normalized for a session. */
  highWaterOf(sessionId: string): number {
    return this.sessions.get(sessionId)?.highWater ?? -1
  }

  /**
   * Normalize and apply every event with seq > highWater. Returns the number
   * of events applied (0 = already up to date). Idempotent by (sessionId, seq).
   */
  ingestEvents(sessionId: string, events: readonly { type: string; seq: number; time: number; data: unknown }[]): number {
    const state = this.ensure(sessionId)
    const start = state.highWater + 1
    const seen: SessionFact[] = []
    let applied = 0
    for (const event of events) {
      if (event.seq < start) continue
      const facts = normalizeEvent(event, state.extractor)
      for (const fact of facts) seen.push(fact)
      state.highWater = Math.max(state.highWater, event.seq)
      applied += 1
    }
    if (seen.length > 0) {
      state.log = boundedFacts(seen.reduce(appendFact, state.log), FACT_RETENTION_PER_KIND)
    }
    return applied
  }

  /** Ingest a single live event (already beyond highWater by construction). */
  ingestEvent(sessionId: string, event: { type: string; seq: number; time: number; data: unknown }): void {
    const state = this.ensure(sessionId)
    if (event.seq <= state.highWater) return
    const facts = normalizeEvent(event, state.extractor)
    state.highWater = event.seq
    if (facts.length > 0) {
      state.log = boundedFacts(facts.reduce(appendFact, state.log), FACT_RETENTION_PER_KIND)
    }
  }

  getLog(sessionId: string): SessionFactLog | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return undefined
    return { ...state.log, facts: [...state.log.facts] }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Forget a session (delete path). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  get size(): number {
    return this.sessions.size
  }
}
