/**
 * Projection consumer unit tests (spec §8.7): pure, synchronous fold; the
 * unit never touches the ledger and works with a minimal fake registry.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { apply as applyProjection } from '../../src/consumers/projection.ts'
import type { OutcomeProjectionView } from '../../src/consumers/projection.ts'

interface FakeRegistry {
  register(def: unknown): void
}

function mount(): { fake: FakeRegistry; viewOf: () => OutcomeProjectionView | undefined } {
  let unit: {
    init(): unknown
    apply(state: unknown, event: unknown): unknown
    view(state: unknown): OutcomeProjectionView
  } | undefined
  const fake: FakeRegistry = {
    register(def) {
      unit = def as never
    },
  }
  const ctx = {
    get(name: string) {
      return name === 'sessionProjections' ? fake : undefined
    },
  } as unknown as Context
  applyProjection(ctx)
  return {
    fake,
    viewOf: () => {
      if (unit === undefined) return undefined
      const state = unit.init()
      return unit.view(state) as OutcomeProjectionView
    },
  }
}

/** Fold a list of events through the registered unit. */
function fold(events: unknown[]): OutcomeProjectionView {
  let unit: {
    init(): unknown
    apply(state: unknown, event: unknown): unknown
    view(state: unknown): OutcomeProjectionView
  } | undefined
  const fake: FakeRegistry = { register(def) { unit = def as never } }
  applyProjection({ get: (n: string) => (n === 'sessionProjections' ? fake : undefined) } as unknown as Context)
  expect(unit).toBeDefined()
  let state = unit!.init()
  for (const event of events) {
    state = unit!.apply(state, event)
  }
  return unit!.view(state)
}

describe('outcome-loop projection', () => {
  it('registers only when the projection service exists', () => {
    const { fake, viewOf } = mount()
    expect(fake.register).toBeDefined()
    expect(viewOf()).toBeDefined()
    // headless: no service → no registration, no throw
    applyProjection({ get: () => undefined } as unknown as Context)
  })

  it('folds turn/step/tool events into a display summary', () => {
    const view = fold([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c1', name: 'bash', arguments: '{}', turn: 1, step: 1 } },
      { type: 'tool/result', seq: 4, time: 4, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '[exit code: 0]' }] }] } } },
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 6, time: 6, data: { source: { kind: 'user' } } },
    ])
    expect(view.turn).toBe(1)
    expect(view.lastTurnReason).toBe('completed')
    expect(view.steps).toBe(1)
    expect(view.toolCalls).toBe(1)
    expect(view.lastExitCode).toBe(0)
    expect(view.latestUserMessageSeq).toBe(6)
    expect(view.toolErrors).toBe(0)
  })

  it('tracks tool errors and returns the same state reference for unrelated events', () => {
    let unit: { init(): unknown; apply(s: unknown, e: unknown): unknown; view(s: unknown): OutcomeProjectionView } | undefined
    const fake: FakeRegistry = { register(def) { unit = def as never } }
    applyProjection({ get: (n: string) => (n === 'sessionProjections' ? fake : undefined) } as unknown as Context)
    let state = unit!.init()
    const unrelated = { type: 'assistant/chunk', seq: 1, time: 1, data: {} }
    expect(unit!.apply(state, unrelated)).toBe(state)
    state = unit!.apply(state, { type: 'tool/result', seq: 2, time: 2, data: { error: { code: 'E1' }, message: { source: { kind: 'tool', callId: 'x' }, content: [{ type: 'tool-result', content: [] }] } } })
    expect(unit!.view(state).toolErrors).toBe(1)
  })

  it('schema validates the view payload', async () => {
    const { z } = await import('zod')
    const view = fold([])
    const schema = z.object({
      stateVersion: z.literal(1),
      turn: z.number(),
      lastTurnReason: z.string().nullable(),
      steps: z.number(),
      toolCalls: z.number(),
      toolErrors: z.number(),
      lastExitCode: z.number().nullable(),
      latestUserMessageSeq: z.number().nullable(),
    })
    expect(schema.safeParse(view).success).toBe(true)
  })
})
