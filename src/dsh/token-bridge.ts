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
}

export function usageFromFacts(log: SessionFactLog | undefined): UsageAggregate {
  if (log === undefined) return { usageKind: 'unknown', calls: 0 }
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let calls = 0
  let exact = false
  for (const fact of log.facts) {
    if (fact.kind !== 'usage') continue
    calls += 1
    if (fact.usageKind === 'exact') exact = true
    if (fact.inputTokens !== undefined) inputTokens += fact.inputTokens
    if (fact.outputTokens !== undefined) outputTokens += fact.outputTokens
    if (fact.totalTokens !== undefined) totalTokens += fact.totalTokens
  }
  if (calls === 0) return { usageKind: 'unknown', calls: 0 }
  return {
    usageKind: exact ? 'exact' : 'unknown',
    inputTokens: inputTokens > 0 ? inputTokens : undefined,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    calls,
  }
}

/** Latest model route observed (lineage only — never a success causal). */
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
