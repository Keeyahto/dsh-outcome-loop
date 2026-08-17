/**
 * Verifier provider registry (spec §12.1): deterministic providers only.
 * Providers return FACTS, never success verdicts for the whole task; the
 * engine aggregates. A judge can never register here (judges are weak-label
 * consumers, not verifiers — see ARCHITECTURE.md).
 */

import type { AcceptanceCriterion, CriterionKind, EvidenceFact, SensitivityClass } from '../domain/types.ts'

export interface VerifierRunInput {
  criterion: AcceptanceCriterion
  /** Resolved scope root (absolute). */
  workspaceRoot: string
  /** Per-criterion configuration snapshot (timeouts, caps). */
  config: { commandTimeoutMs: number; maxCommandOutputBytes: number }
  /** Deterministic params from the criterion specification (custom kind). */
  params: unknown
}

export interface VerifierOutput {
  fact: EvidenceFact
  strength: 'strong' | 'medium'
  sensitivity: SensitivityClass
}

export interface VerifierProvider {
  /** Stable provider id (referenced by `custom` criteria and policy allowlists). */
  readonly id: string
  /** Criterion kinds this provider can verify. */
  readonly kinds: readonly CriterionKind[]
  /** Whether the provider only observes existing state (never executes). */
  readonly observesOnly: boolean
  /** Whether the provider executes commands (must be policy-allowed). */
  readonly executesCommands: boolean
  /** Whether the provider touches the network (default: never). */
  readonly networkAccess: boolean
  /** What evidence strength its facts carry. */
  readonly producesStrength: 'strong' | 'medium'
  /** Run synchronously or return a promise; must respect cancellation. */
  run(input: VerifierRunInput, signal?: AbortSignal): Promise<VerifierOutput>
}

export class VerifierRegistry {
  private readonly providers = new Map<string, VerifierProvider>()

  register(provider: VerifierProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`outcome-loop: verifier provider '${provider.id}' is already registered`)
    }
    this.providers.set(provider.id, provider)
    return () => {
      this.providers.delete(provider.id)
    }
  }

  get(id: string): VerifierProvider | undefined {
    return this.providers.get(id)
  }

  list(): readonly VerifierProvider[] {
    return [...this.providers.values()]
  }

  get size(): number {
    return this.providers.size
  }
}
