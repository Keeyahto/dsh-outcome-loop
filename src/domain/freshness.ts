/**
 * Evidence freshness (spec §7.4 rules 7–8, §12.4) — pure functions.
 *
 * A passing test only proves the workspace state at capture time. Evidence
 * goes stale when the contract revision moves, when the workspace changed
 * after capture, or when it exceeds its maximum age. When we cannot tell
 * (no observable workspace state), we conservatively answer `unknown` and
 * the aggregator treats the criterion as unknown rather than pass.
 */

import type { Evidence, EvidenceFreshnessPolicy } from './types.ts'

export type Freshness = 'fresh' | 'stale' | 'unknown'

export interface FreshnessContext {
  /** Contract revision at evidence capture time (stored on the row). */
  capturedContractRevision: number
  /** Contract revision right now. */
  currentContractRevision: number
  /** Workspace epoch right now; `undefined` when unknown (no fact log). */
  currentWorkspaceEpoch: number | undefined
  /** Verifier/config digest change bumps this — see COMPATIBILITY.md. */
  verifierVersion: string
  capturedVerifierVersion: string
  now: number
}

export function evidenceFreshness(
  evidence: Evidence,
  policy: EvidenceFreshnessPolicy,
  context: FreshnessContext,
): Freshness {
  // Contract revision moved → evidence captured under the old contract is stale.
  if (context.capturedContractRevision !== context.currentContractRevision) {
    return 'stale'
  }

  // Verifier version moved → old observations may no longer be interpretable.
  if (context.capturedVerifierVersion !== context.verifierVersion) {
    return 'stale'
  }

  // Maximum age.
  if (policy.maxAgeMs !== undefined && policy.maxAgeMs > 0) {
    if (context.now - evidence.observedAt > policy.maxAgeMs) {
      return 'stale'
    }
  }

  if (!policy.invalidateOnWorkspaceChange) {
    return 'fresh'
  }

  // Workspace change invalidation. Unknown current epoch ⇒ conservative unknown.
  if (context.currentWorkspaceEpoch === undefined) {
    return 'unknown'
  }
  if (context.currentWorkspaceEpoch > evidence.workspaceState.epoch) {
    return 'stale'
  }
  return 'fresh'
}
