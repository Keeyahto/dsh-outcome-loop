/**
 * Optional session projection consumer (spec §8.7): a pure, synchronous fold
 * of session events into a small display summary for the Web client. It is
 * NOT authoritative evidence — the ledger sidecar is. This row is safe in
 * headless assemblies: the projection service is optional.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { z } from 'zod'

export const name = 'outcome-loop-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'outcome-loop/summary': OutcomeProjectionView
  }
}

// The augmentation merges into the imported interface; keep an explicit
// reference so tooling sees the dependency.
type _MergedProjectionKeys = keyof SessionProjectionMap

export interface OutcomeProjectionView {
  stateVersion: 1
  turn: number
  lastTurnReason: string | null
  steps: number
  toolCalls: number
  toolErrors: number
  lastExitCode: number | null
  latestUserMessageSeq: number | null
}

export const outcomeProjectionViewSchema = z.object({
  stateVersion: z.literal(1),
  turn: z.number().int().nonnegative(),
  lastTurnReason: z.string().nullable(),
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolErrors: z.number().int().nonnegative(),
  lastExitCode: z.number().int().nullable(),
  latestUserMessageSeq: z.number().int().nonnegative().nullable(),
})

interface ProjectionState {
  turn: number
  lastTurnReason: string | null
  steps: number
  toolCalls: number
  toolErrors: number
  lastExitCode: number | null
  latestUserMessageSeq: number | null
}

const INITIAL: ProjectionState = Object.freeze({
  turn: 0,
  lastTurnReason: null,
  steps: 0,
  toolCalls: 0,
  toolErrors: 0,
  lastExitCode: null,
  latestUserMessageSeq: null,
})

const EXIT_RE = /\[exit code:\s*(-?\d+)\]/

/** Extract text from a tool-result event payload (counts only, no content kept). */
function exitCodeOf(event: SessionEvent & { type: 'tool/result' }): number | null {
  const blocks = event.data.message?.content?.[0]?.content
  if (!Array.isArray(blocks)) return null
  let text = ''
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  const match = EXIT_RE.exec(text)
  return match !== null && Number.isInteger(Number(match[1])) ? Number(match[1]) : null
}

export function apply(ctx: Context): void {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return
  projections.register({
    key: 'outcome-loop/summary',
    schema: outcomeProjectionViewSchema,
    stateVersion: 1,
    init: () => INITIAL,
    apply(state: ProjectionState, event: SessionEvent): ProjectionState {
      switch (event.type) {
        case 'turn/start':
          if (state.turn === event.data.turn) return state
          return { ...state, turn: event.data.turn }
        case 'turn/end':
          if (state.lastTurnReason === event.data.reason.kind) return state
          return { ...state, lastTurnReason: event.data.reason.kind }
        case 'step/start':
          return { ...state, steps: state.steps + 1 }
        case 'user/message':
          if (state.latestUserMessageSeq === event.seq) return state
          return { ...state, latestUserMessageSeq: event.seq }
        case 'tool/call':
          return { ...state, toolCalls: state.toolCalls + 1 }
        case 'tool/result': {
          const toolErrors = Boolean(event.data.error) ? state.toolErrors + 1 : state.toolErrors
          const lastExitCode = exitCodeOf(event)
          if (toolErrors === state.toolErrors && lastExitCode === state.lastExitCode) return state
          return { ...state, toolErrors, lastExitCode: lastExitCode ?? state.lastExitCode }
        }
        default:
          return state
      }
    },
    view(state: ProjectionState): OutcomeProjectionView {
      return {
        stateVersion: 1,
        turn: state.turn,
        lastTurnReason: state.lastTurnReason,
        steps: state.steps,
        toolCalls: state.toolCalls,
        toolErrors: state.toolErrors,
        lastExitCode: state.lastExitCode,
        latestUserMessageSeq: state.latestUserMessageSeq,
      }
    },
  })
}
