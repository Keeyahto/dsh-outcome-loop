/**
 * Token/cost bridge (spec §8.6): reuse durable usage facts instead of
 * re-estimating model content. Only token counts are ever stored — prices
 * are never hardcoded and monetary cost is never computed.
 */

import type { SessionFactLog } from '../domain/types.ts'

export interface UsageAggregate {
  usageKind: 'exact' | 'estimate' | 'unknown'
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  calls: number
  /** Latest route lineage, when observed (used for price-table matching). */
  provider?: string
  model?: string
}

export function usageFromFacts(log: SessionFactLog | undefined): UsageAggregate {
  if (log === undefined) return { usageKind: 'unknown', calls: 0 }
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let calls = 0
  let exact = false
  let provider: string | undefined
  let model: string | undefined
  for (const fact of log.facts) {
    if (fact.kind === 'usage') {
      calls += 1
      if (fact.usageKind === 'exact') exact = true
      if (fact.inputTokens !== undefined) inputTokens += fact.inputTokens
      if (fact.outputTokens !== undefined) outputTokens += fact.outputTokens
      if (fact.totalTokens !== undefined) totalTokens += fact.totalTokens
    } else if (fact.kind === 'route' && provider === undefined) {
      provider = fact.provider
      model = fact.model
    }
  }
  if (calls === 0) return { usageKind: 'unknown', calls: 0 }
  return {
    usageKind: exact ? 'exact' : 'unknown',
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    inputTokens: inputTokens > 0 ? inputTokens : undefined,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    calls,
  }
}

/** Latest model route observed (lineage only — never a success causal). */
export interface PriceTableEntry {
  provider: string
  model: string
  currency: string
  /** Price per 1M tokens. */
  pricePerMillionInput: number
  pricePerMillionOutput: number
  /** Unix epoch ms from which this entry is effective. */
  effectiveFrom: number
  /** Where the price came from (URL, doc version, …). */
  source: string
}

export interface CostEstimate {
  currency: string
  inputCost: number
  outputCost: number
  totalCost: number
  entry: { provider: string; model: string; effectiveFrom: number; source: string }
}

/**
 * Monetary cost ONLY when the user configured a versioned, sourced price
 * table (spec §8.6). Never hardcoded prices; without a matching entry the
 * answer is undefined and the caller reports tokens only.
 */
export function costOf(
  usage: UsageAggregate,
  table: readonly PriceTableEntry[],
  now: number,
): CostEstimate | undefined {
  if (usage.usageKind !== 'exact' || table.length === 0) return undefined
  const candidates = table.filter((e) =>
    e.effectiveFrom <= now
    && (usage.provider === undefined || e.provider === usage.provider)
    && (usage.model === undefined || e.model === usage.model),
  )
  if (candidates.length === 0) return undefined
  const entry = candidates.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b))
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const inputCost = (inputTokens / 1_000_000) * entry.pricePerMillionInput
  const outputCost = (outputTokens / 1_000_000) * entry.pricePerMillionOutput
  return {
    currency: entry.currency,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    entry: { provider: entry.provider, model: entry.model, effectiveFrom: entry.effectiveFrom, source: entry.source },
  }
}
export function routesFromFacts(log: SessionFactLog | undefined): readonly { provider: string; model: string }[] {
  if (log === undefined) return []
  const routes: { provider: string; model: string }[] = []
  const seen = new Set<string>()
  for (const fact of log.facts) {
    if (fact.kind !== 'route') continue
    const key = `${fact.provider}\u0000${fact.model}`
    if (!seen.has(key)) {
      seen.add(key)
      routes.push({ provider: fact.provider, model: fact.model })
    }
  }
  return routes
}
