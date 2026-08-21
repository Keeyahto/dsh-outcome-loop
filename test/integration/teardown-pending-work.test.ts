/**
 * Lifecycle regression (`.6`): an operation accepted into `SessionQueue`
 * BEFORE plugin teardown MUST reach the durable storage domain. The previous
 * `.5` dual-disposer race could close the domain ahead of `queue.drain()`,
 * dropping the underlying `repository.put*` with `DomainError('closed')`.
 *
 * Coverage:
 *
 *   1. `createContract` enqueued but not yet committed → `ctx.stop()` →
 *      a fresh `Context` reads the contract back from disk.
 *
 *   2. Live observation work (`session/event` observed just before teardown)
 *      reaches the repository's cursor table before the domain closes, and a
 *      fresh process observes the advanced cursor. This is the case the new
 *      `ObserverHandle.accepting` gate + barrier drain protects.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { apply, Config } from '../../src/index.ts'
import { outcomeDomainSpec } from '../../src/persistence/schema.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-teardown-pending-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface BootBundle { ctx: Context; facility: DomainFacility; outcome: unknown; fiber: { dispose(): Promise<void>; await(): Promise<void> } }

async function bootOnce(): Promise<BootBundle> {
  const ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.reflect.provide('storageDomain', facility)

  const fiber = ctx.registry.plugin(
    { name: 'outcome-loop', inject: ['storageDomain'], Config, apply },
    Config({}) as ReturnType<typeof Config>,
  ) as unknown as { dispose(): Promise<void>; await(): Promise<void> }
  await fiber.await()
  return { ctx, facility, outcome: ctx.outcomeLoop, fiber }
}

interface LoadOutcome { outcome: unknown; ctx: Context; facility: DomainFacility; fiber: { dispose(): Promise<void>; await(): Promise<void> } }

async function loadOutcome(rootDir: string): Promise<LoadOutcome> {
  const ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(rootDir))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.reflect.provide('storageDomain', facility)

  const fiber = ctx.registry.plugin(
    { name: 'outcome-loop', inject: ['storageDomain'], Config, apply },
    Config({}) as ReturnType<typeof Config>,
  ) as unknown as { dispose(): Promise<void>; await(): Promise<void> }
  await fiber.await()
  return { ctx, facility, outcome: ctx.outcomeLoop, fiber }
}

describe('teardown owns queue then domain — lifecycle regression (.6)', () => {
  it('accepted createContract reaches durable storage across a graceful stop, and a fresh process reads it back', async () => {
    const { ctx, fiber } = await bootOnce()

    // Submit the work, then schedule the dispose WITHOUT awaiting it. The
    // `createContract(...)` promise races the dispose; the fix promises the
    // contract lands in durable storage exactly once.
    const createdP = (ctx.outcomeLoop as { createContract(input: { sessionId: string; goalText: string }): Promise<{ ok: boolean; value?: { id: string }; error?: { code: string } }> })
      .createContract({ sessionId: 's-pend', goalText: 'pending at teardown' })
    const stopP = fiber.dispose()

    const [created, _stopped] = await Promise.all([createdP, stopP])

    expect(created.ok).toBe(true)
    if (!created.ok) return
    const firstId = created.value.id

    // A fresh process must reconstruct the SAME contract. We deliberately do
    // NOT inspect the on-disk JSON shape here — the durable medium's layout is
    // an implementation detail owned by the storage-domain layer; what matters
    // is that the next process, on a cold boot of the same root, recovers the
    // contract.
    const second = await loadOutcome(root)
    const listed = await (second.outcome as { listContracts(query: { sessionId: string }): Promise<{ ok: boolean; value?: readonly { id: string }[]; error?: { code: string } }> })
      .listContracts({ sessionId: 's-pend' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.length).toBe(1)
    expect(listed.value[0]!.id).toBe(firstId)
  })

  it('pending session/event observed just before stop survives: cursor advances and is readable on cold boot', async () => {
    const { ctx, fiber } = await bootOnce()

    // Create a contract so cursor persistence has a reason to fire (observer
    // only persists the cursor when a contract exists for the session).
    const created = await (ctx.outcomeLoop as { createContract(input: { sessionId: string; goalText: string }): Promise<{ ok: boolean }> })
      .createContract({ sessionId: 's-cursor', goalText: 'cursor survival' })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const emit = (ctx as unknown as { emit(name: string, ...args: unknown[]): unknown }).emit.bind(ctx)
    const session = { id: 's-cursor', events: [] }

    // Three events back-to-back — the second/third queue entries race the
    // gate and the drain barrier.
    emit('session/event', session, { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } })
    emit('session/event', session, { type: 'user/message', seq: 2, time: 2000, data: { source: { kind: 'user' } } })
    emit('session/event', session, { type: 'turn/end', seq: 3, time: 3000, data: { turn: 1, reason: { kind: 'completed' } } })

    // Dispose the fiber without explicitly awaiting the registry-driven
    // ingestion promise; the gate + drain MUST drain those three events
    // before the domain closes.
    await fiber.dispose()

    const second = await loadOutcome(root)
    const repository = (second.outcome as unknown as { repository: { getCursor(id: string): { lastSeq: number } | undefined } }).repository
    const cursor = repository.getCursor('s-cursor')
    expect(cursor).toBeDefined()
    expect(cursor!.lastSeq).toBe(3)
  })

  it('enqueue() rejects with queue-draining after drain begins', async () => {
    const { SessionQueue } = await import('../../src/persistence/queue.ts')
    const q = new SessionQueue()
    const draining = q.drain()
    let threw: unknown
    try {
      q.enqueue({ sessionId: 'x', run: async () => {} })
    } catch (error) {
      threw = error
    }
    await draining
    expect(threw).toBeInstanceOf(Error)
    expect((threw as Error).message).toMatch(/queue-draining/)
  })
})
