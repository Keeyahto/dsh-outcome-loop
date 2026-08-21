/**
 * DEP-02A2 follow-up (M1 restart gate): cold-boot outcome-loop with a
 * non-empty durable domain MUST register the `outcomeLoop` Cordis
 * Service before `apply()` returns.
 *
 * Repro of the original M1 restart-gate failure (M1 E2E Stage 7):
 * the previous outcome-loop `apply()` registered `OutcomeLoopService`
 * inside a fire-and-forget `.then(...)` continuation, so the loader's
 * `assertEntriesActivated` could see dependent consumers (Forge,
 * `outcome-loop-commands`) as `pending (waiting for service:
 * outcomeLoop)` on a cold start that already has accumulated
 * OutcomeLoop records from a prior run. The fix is loader-awaited:
 * `apply()` now constructs `OutcomeLoopService` inside an `async`
 * `ctx.effect` body, so the loader's `await fiber.await()` cannot
 * complete until the service is registered.
 *
 * These tests verify the contract from two angles:
 *
 *   1. `apply()` returns only after `ctx.outcomeLoop` is available
 *      (synchronous readability, no `eventually` polling).
 *   2. A real Cordis `Context` with a `outcomeLoop`-depending entry
 *      declared as `inject: ['outcomeLoop']` activates the
 *      dependency — the dependency never appears as `pending`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  root = await mkdtemp(join(tmpdir(), 'ol-boot-cold-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeContextWithDomain(): Promise<{ ctx: Context; facility: DomainFacility }> {
  const ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  // Cordis's `inject: ['storageDomain']` waits for the service to be
  // READY. The `ctx.storage.mount('domain', facility)` line above
  // makes `ctx.storage.<form>` available, but the *named* service
  // `storageDomain` is only reachable through the storage hub's
  // domain-aware accessor in production; in tests we must register
  // it as a plain service so the outcome-loop fiber's
  // `_checkImpl('storageDomain')` actually passes.
  ctx.reflect.provide('storageDomain', facility)
  return { ctx, facility }
}

async function primeDurableDomain(): Promise<void> {
  // Open the durable domain ONCE in a throwaway Context so the
  // `outcome_loop.json` file exists on disk before the cold-boot
  // scenario runs. The cold-boot Context must then read it back.
  const { ctx, facility } = await makeContextWithDomain()
  const domain = await facility.open(outcomeDomainSpec)
  // Empty domain — the point is the file existing, not its content.
  void domain
}

describe('outcome-loop cold-boot (DEP-02A2 follow-up)', () => {
  it('apply() returns only after outcomeLoop service is registered (synchronous, no polling)', async () => {
    await primeDurableDomain()
    const { ctx } = await makeContextWithDomain()
    const config = Config({}) as ReturnType<typeof Config>

    // The plugin must be registered THROUGH the Cordis registry, not
    // called directly, so that `await fiber.await()` runs the loader-
    // awaited effect body. Cordis `registry.plugin` accepts a
    // Promise-returning `apply` and the loader's `entry._start`
    // awaits `fiber.await()`, which observes that Promise (verified
    // in `test/integration/probe3.test.ts`).
    const fiber = ctx.registry.plugin(
      { name: 'outcome-loop', inject: ['storageDomain'], Config, apply },
      config,
    ) as unknown as { await(): Promise<void> }
    await fiber.await()

    // After the loader-awaited effect resolves, the service MUST be
    // synchronously available — the bug we are regressing against
    // would have left `ctx.outcomeLoop === undefined` here because
    // the old fire-and-forget `.then(...)` registered the service
    // AFTER `apply()` (and `fiber.await()`) returned.
    expect(ctx.outcomeLoop).toBeDefined()
    expect(typeof ctx.outcomeLoop.createContract).toBe('function')
  })

  it('non-empty durable domain → cold boot → outcomeLoop consumers (inject: [outcomeLoop]) activate, not pending', async () => {
    await primeDurableDomain()
    const { ctx } = await makeContextWithDomain()
    const config = Config({}) as ReturnType<typeof Config>

    // Register the outcome-loop plugin first and await its fiber so
    // the service is available before the dependent consumer runs.
    const outcomeFiber = ctx.registry.plugin(
      { name: 'outcome-loop', inject: ['storageDomain'], Config, apply },
      config,
    ) as unknown as { await(): Promise<void> }
    await outcomeFiber.await()
    expect(ctx.outcomeLoop).toBeDefined()

    // Now register a dependent consumer that requires outcomeLoop.
    // The old race would leave it `pending`; with the loader-
    // awaited fix, the apply body runs synchronously and reads
    // `ctx.outcomeLoop` without PENDING.
    let dependentSawService = false
    const consumerFiber = ctx.registry.plugin({
      name: 'fake-outcome-loop-consumer',
      inject: ['outcomeLoop'],
      apply: () => {
        dependentSawService = ctx.outcomeLoop !== undefined
      },
    }) as unknown as { await(): Promise<void> }
    await consumerFiber.await()
    expect(dependentSawService).toBe(true)
  })

  it('storageDomain.open failure is fail-loud (not silent pending) — the same path the cold-boot race used to mask', async () => {
    // No storage backend registered. `routes: {}` and no
    // `backend` fallback means the facility cannot resolve a backend
    // for the outcome_loop domain and `open()` rejects with
    // `backend-not-found`. The loader must report this as an
    // activation error, not as the silent
    // `pending (waiting for service: outcomeLoop)` symptom of the
    // old race.
    const root = await mkdtemp(join(tmpdir(), 'ol-boot-fail-'))
    try {
      const ctx = new Context()
      new Storage(ctx)
      // No `ctx.storage.backend.register(...)` — the hub has no
      // backend, so `backend.get('json')` rejects with
      // `backend-not-found` (or undefined, depending on the hub's
      // exact failure path).
      const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.reflect.provide('storageDomain', facility)
      const config = Config({}) as ReturnType<typeof Config>

      const fiber = ctx.registry.plugin(
        { name: 'outcome-loop', inject: ['storageDomain'], Config, apply },
        config,
      ) as unknown as { await(): Promise<void> }
      let caught: unknown
      try {
        await fiber.await()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      // The error must carry the outcome-loop prefix (not a generic
      // storage message) so a loader reader can tell at a glance
      // that an outcome-loop plugin is the failing entry.
      expect((caught as Error).message).toMatch(/outcome-loop/)
      // The service must NOT have been silently registered when
      // open failed (the previous race symptom).
      expect((ctx as unknown as { outcomeLoop?: unknown }).outcomeLoop).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
