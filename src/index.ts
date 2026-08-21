/**
 * dsh-outcome-loop — task outcome ledger & acceptance plugin for DSH.
 *
 * Default composition (spec §11): zero extra model cost, zero network, zero
 * active commands, local sidecar storage only. Model-visible surface: none.
 *
 * Plugin rows in this bundle:
 * - `outcome-loop`          → this entry (service + observer + storage)
 * - `outcome-loop-commands` → the human `/outcome` command consumer
 * - `outcome-loop-projection` → optional Web session projection (headless-safe)
 */

import { Context } from '@deepseek-ai/cordis'

import { Config, type ConfigType } from './config.ts'
import { KNOWN_COMPATIBLE_DSH } from './dsh/compatibility.ts'
import { OutcomeLoopService } from './service.ts'
import { outcomeDomainSpec } from './persistence/schema.ts'

export const name = 'outcome-loop'
export const inject = ['storageDomain']
export { Config }
export { OutcomeLoopService } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    outcomeLoop: OutcomeLoopService
  }
}

export const VERSION = '0.1.0-beta.8-keeyahto.5'

/** Validate config at load time; fail loud on impossible values. */
export function validateConfig(config: ConfigType): void {
  if (!Number.isSafeInteger(config.verification.commandTimeoutMs) || config.verification.commandTimeoutMs < 1) {
    throw new TypeError('outcome-loop: verification.commandTimeoutMs must be a positive integer')
  }
  if (!Number.isSafeInteger(config.verification.maxCommandOutputBytes) || config.verification.maxCommandOutputBytes < 1) {
    throw new TypeError('outcome-loop: verification.maxCommandOutputBytes must be a positive integer')
  }
  if (config.verification.llmJudge !== 'disabled') {
    throw new TypeError('outcome-loop: llmJudge must stay disabled in this release (weak labels only, see ARCHITECTURE.md)')
  }
  if (config.privacy.network !== 'disabled') {
    throw new TypeError('outcome-loop: privacy.network must stay disabled in this release (no network capability exists)')
  }
  if (config.capture.rawMessages || config.capture.rawToolArguments || config.capture.rawToolResults) {
    throw new TypeError('outcome-loop: raw content capture is not implemented and must stay false')
  }
  for (const entry of config.cost.priceTable) {
    if (!Number.isFinite(entry.pricePerMillionInput) || entry.pricePerMillionInput < 0
      || !Number.isFinite(entry.pricePerMillionOutput) || entry.pricePerMillionOutput < 0) {
      throw new TypeError('outcome-loop: cost.priceTable prices must be non-negative finite numbers')
    }
    if (entry.currency.trim().length === 0) {
      throw new TypeError('outcome-loop: cost.priceTable entries need a non-empty currency')
    }
    if (!Number.isFinite(entry.effectiveFrom) || entry.effectiveFrom < 0) {
      throw new TypeError('outcome-loop: cost.priceTable entries need a non-negative effectiveFrom (epoch ms)')
    }
    if (entry.source.trim().length === 0) {
      throw new TypeError('outcome-loop: cost.priceTable entries need a source (provenance)')
    }
  }
}

/** Trusted env allowlist for active verification (never the full process env). */
function trustedEnv(env: Readonly<Record<string, string | undefined>> | undefined): Readonly<Record<string, string>> {
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'USER', 'LOGNAME'])
  const out: Record<string, string> = {}
  if (env === undefined) return out
  for (const key of allowed) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

/**
 * DEP-02A2 follow-up: the previous implementation registered
 * `OutcomeLoopService` inside a fire-and-forget `.then(...)`, which
 * meant `apply()` returned BEFORE the service constructor ran and
 * BEFORE the `outcomeLoop` Cordis Service was registered. Downstream
 * consumers that declare `inject: ['outcomeLoop']` (e.g.
 * `outcome-loop-commands` and Forge's hard-inject consumer) entered
 * the boot graph as `pending` and could race past the loader's
 * `assertEntriesActivated` deadline on a cold start that already
 * has accumulated OutcomeLoop records from a prior run.
 *
 * The fix is loader-awaited: the plugin entry returns a
 * `Promise<void>` directly. The Cordis plugin registry recognizes
 * a Promise return and the loader's `await fiber.await()` waits on
 * it (verified empirically in `test/integration/probe3.test.ts`).
 * The order is therefore:
 *
 *   1. await ctx.storageDomain.open(outcomeDomainSpec)  (resource ready)
 *   2. new OutcomeLoopService(ctx, ...)                (synchronous constructor
 *                                                      registers `outcomeLoop`
 *                                                      Cordis Service via super())
 *   3. apply() resolves, the loader's `assertEntriesActivated`
 *      fires, and dependent consumers find `ctx.outcomeLoop` ready.
 *
 * The async-throw path is still fail-loud (never silently degrade:
 * outcome data cannot be durable without the storage domain), but
 * the throw now propagates through the await chain and the loader
 * reports the actual cause instead of the `pending (waiting for
 * service: outcomeLoop)` symptom.
 *
 * The previous `ctx.effect(async () => ...)` approach did NOT
 * resolve this: `ctx.effect` runs the callback on a separate
 * internal fiber whose `await fiber.await()` does NOT await the
 * effect setup (the Cordis Fiber `await()` only waits on `inertia`,
 * which is set on reload/unload, not on initial setup). Awaiting
 * the storage domain DIRECTLY inside `apply` is the only path
 * that the loader's `entry._start -> await fiber.await()` actually
 * observes.
 */
export async function apply(ctx: Context, config: ConfigType): Promise<void> {
  validateConfig(config)

  let domain
  try {
    domain = await ctx.storageDomain.open(outcomeDomainSpec)
  } catch (error: unknown) {
    ctx.logger?.error(`outcome-loop: failed to open the outcome_loop storage domain: ${error instanceof Error ? error.message : String(error)}`)
    throw new Error(
      `outcome-loop: failed to open the outcome_loop storage domain: `
      + (error instanceof Error ? error.message : String(error)),
    )
  }
  new OutcomeLoopService(ctx, {
    config,
    domain,
    ctx,
    version: VERSION,
    dshVersion: KNOWN_COMPATIBLE_DSH,
    trustedEnv: trustedEnv(process.env),
  })
  // Register a domain-close disposer on the current fiber so the
  // loader's unload path closes the storage unit on plugin teardown.
  // We do this here (instead of returning a dispose function) so
  // the public apply() signature stays `Promise<void>`, which is
  // exactly the shape Cordis plugin loader's `entry._start ->
  // await fiber.await()` waits on.
  ctx.effect(() => {
    return () => {
      void domain.close().catch(() => {
        // Domain close failures during teardown are non-fatal;
        // the facility reaps the unit on unmount anyway.
      })
    }
  })
}

export interface OutcomeLoopPluginEntry {
  name: string
  inject: readonly string[]
  Config: typeof Config
  apply: (ctx: Context, config: ConfigType) => void
}

export const defaultExport: OutcomeLoopPluginEntry = { name, inject, Config, apply }
export default defaultExport
