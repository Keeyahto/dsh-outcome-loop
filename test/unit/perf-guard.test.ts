/**
 * Hot-path performance guard (spec §13): the `session/event` normalization
 * path must stay constant-size and linear; the ledger must stay bounded.
 */

import { describe, expect, it } from 'vitest'

import { createExtractorState, normalizeEvent } from '../../src/dsh/events.ts'
import { FactRegistry, FACT_RETENTION_PER_KIND } from '../../src/dsh/registry.ts'

describe('hot path budget (spec §13)', () => {
  it('normalizes 5000 mixed events under a loose wall-clock budget', () => {
    const state = createExtractorState()
    const started = performance.now()
    let facts = 0
    for (let i = 0; i < 2500; i += 1) {
      const seq = i * 2 + 1
      facts += normalizeEvent({ type: 'turn/start', seq, time: seq, data: { turn: i } }, state).length
      facts += normalizeEvent({
        type: 'tool/call',
        seq: seq + 1,
        time: seq + 1,
        data: { callId: `c${i}`, name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }), turn: i, step: 1 },
      }, state).length
    }
    const elapsed = performance.now() - started
    // Loose bound: normalization is pure string work; 5000 events should be
    // far below this even on slow CI machines.
    expect(elapsed).toBeLessThan(2000)
    // Constant-size output: at most 2 facts per event pair (call + no result here).
    expect(facts).toBe(5000)
  })

  it('keeps per-kind fact retention bounded regardless of event volume', () => {
    const registry = new FactRegistry()
    const events = []
    for (let i = 0; i < 10_000; i += 1) {
      events.push({ type: 'turn/end', seq: i, time: i, data: { turn: i, reason: { kind: 'completed' } } })
    }
    registry.ingestEvents('s-perf', events)
    const log = registry.getLog('s-perf')
    expect(log?.facts.length).toBeLessThanOrEqual(FACT_RETENTION_PER_KIND + 8)
    expect(log?.seqEnd).toBe(9999)
    expect(log?.workspaceEpoch).toBe(0)
  })

  it('produces no more than 2 facts per event in the hot path', () => {
    const state = createExtractorState()
    const single = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: 2, data: { callId: 'c', name: 'bash', arguments: '{}', turn: 1, step: 1 } },
      { type: 'tool/result', seq: 3, time: 3, data: { message: { source: { kind: 'tool', callId: 'c' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'TAP version 13\n1..1\nok 1\n' }] }] } } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    for (const event of single) {
      expect(normalizeEvent(event, state).length).toBeLessThanOrEqual(2)
    }
  })
})
