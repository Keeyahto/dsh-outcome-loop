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

export const VERSION = '0.1.0-beta.7-keeyahto.1'

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

export function apply(ctx: Context, config: ConfigType): void {
  validateConfig(config)

  ctx.effect(() => {
    const domainPromise = ctx.storageDomain.open(outcomeDomainSpec)
    let closed = false

    void domainPromise.then(
      (domain) => {
        if (closed) {
          void domain.close()
          return
        }
        new OutcomeLoopService(ctx, {
          config,
          domain,
          ctx,
          version: VERSION,
          dshVersion: KNOWN_COMPATIBLE_DSH,
          trustedEnv: trustedEnv(process.env),
        })
      },
      (error: unknown) => {
        // Fail loud, never silently degrade: outcome data cannot be durable
        // without the storage domain.
        ctx.logger?.error(`outcome-loop: failed to open the outcome_loop storage domain: ${error instanceof Error ? error.message : String(error)}`)
      },
    )

    return () => {
      closed = true
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
