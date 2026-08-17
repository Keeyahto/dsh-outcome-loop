/**
 * Session observation + replay (spec §8.2, §8.3): live tail via `session/event`,
 * seed + history via snapshot fills from the live session store (or cold reads
 * through the optional session-persistence service).
 *
 * Replay contract:
 * - the durable `session/event` firehose only publishes new appends; constructor
 *   seeds never re-emit, so history is replayed from `ctx.sessions.get(id).events`;
 * - every event is deduplicated by `(sessionId, seq)` via the registry high-water;
 * - a `session/created` fire triggers a fill (resume/fork paths);
 * - seq gaps cannot be silently bridged by guessing: a fill reads the whole
 *   authoritative log, and a session with no accessible log simply contributes
 *   no facts (criterion stays `unknown` — never a fabricated pass).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import type { Repository } from '../persistence/repository.ts'
import type { SessionQueue } from '../persistence/queue.ts'
import { isSessionEventShape, sessionStoreSurface } from './compatibility.ts'
import type { FactRegistry } from './registry.ts'

export interface ObserverDeps {
  ctx: Context
  registry: FactRegistry
  repository: Repository
  queue: SessionQueue
  /** True when a contract exists for this session (cursor persistence). */
  hasContract: (sessionId: string) => boolean
  logger: { warn(message: string, ...args: unknown[]): void }
}

export interface ReplayDeps extends ObserverDeps {
  /** Optional cold-read service; absent ⇒ live-store fills only. */
  sessionPersistence?: SessionPersistence
}

export function fillLiveSession(deps: ReplayDeps, session: Session): void {
  // Live Session surface: read authoritative in-memory events (seed + tail).
  const events = session.events
  if (events.length > 0) {
    deps.queue.enqueue({
      sessionId: session.id,
      run: () => {
        deps.registry.ingestEvents(session.id, events)
        return Promise.resolve()
      },
    })
  }
}

/** Best-effort cold fill through the optional session-persistence service. */
export async function fillColdSession(deps: ReplayDeps, sessionId: string): Promise<boolean> {
  const persistence = deps.sessionPersistence
  if (persistence === undefined) return false
  try {
    const inspection: SessionInspection = await persistence.inspect(sessionId as never)
    deps.queue.enqueue({
      sessionId,
      run: () => {
        deps.registry.ingestEvents(sessionId, inspection.events)
        return Promise.resolve()
      },
    })
    return true
  } catch (error) {
    deps.logger.warn(`outcome-loop: cold replay failed for ${sessionId}`, error)
    return false
  }
}

/**
 * Mount observation: subscribe to `session/event`, fill live sessions at
 * startup, and re-fill on `session/created` (resume/fork). Returns the
 * disposer for the caller's fiber.
 */
export function mountObserver(deps: ReplayDeps): () => void {
  const { ctx, registry } = deps

  // Startup: fill every live session (covers sessions that stay live across
  // a plugin restart and never re-announce).
  const live = ctx.get('sessions') as { list(): Session[] } | undefined
  sessionStoreSurface(live)
  if (live !== undefined) {
    for (const session of live.list()) fillLiveSession(deps, session)
  }

  // Resume/fork path: a re-announced session re-fills from its authoritative log.
  ctx.on('session/created', (session: Session) => {
    fillLiveSession(deps, session)
  })

  // Live tail (hot path — constant-time normalize + enqueue).
  ctx.on('session/event', (session: Session, event: unknown) => {
    if (!isSessionEventShape(event)) {
      deps.logger.warn('outcome-loop: dropped a session event with an unsupported envelope')
      return
    }
    const sessionId = session.id
    const firstContact = !registry.has(sessionId)
    if (firstContact) {
      // Ensure history precedes the live event (dedupe by seq keeps it safe).
      fillLiveSession(deps, session)
    }
    deps.queue.enqueue({
      sessionId,
      run: async () => {
        registry.ingestEvent(sessionId, event)
        if (deps.hasContract(sessionId)) {
          await deps.repository.advanceCursor(sessionId, event.seq)
        }
      },
    })
  })

  return () => {
    // Listener disposers ride the fiber automatically; nothing else to free.
  }
}
