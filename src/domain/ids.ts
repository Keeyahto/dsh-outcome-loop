/**
 * Branded identifiers and deterministic id derivation.
 *
 * Pure domain: no DSH, no filesystem, no clock.
 */

export type ContractId = string & { readonly __brand: 'ContractId' }
export type CriterionId = string & { readonly __brand: 'CriterionId' }
export type EvidenceId = string & { readonly __brand: 'EvidenceId' }
export type VerificationRunId = string & { readonly __brand: 'VerificationRunId' }
export type ExportId = string & { readonly __brand: 'ExportId' }
export type SessionIdRef = string
export type SeqRef = number

const PREFIXES = {
  contract: 'olc',
  criterion: 'olcr',
  evidence: 'ole',
  run: 'olr',
  export: 'olx',
} as const

/**
 * Stable content hash (FNV-1a 64-bit, hex) — deterministic across runs and
 * processes, no randomness. Used for ids derived from durable facts so that
 * replay and re-delivery produce the same id (idempotency key).
 */
export function contentHash(...parts: readonly (string | number)[]): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const feed = (value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      hash ^= BigInt(value.charCodeAt(i))
      hash = (hash * prime) & 0xffffffffffffffffn
    }
  }
  for (const part of parts) {
    feed(String(part))
    feed('\u0000')
  }
  return hash.toString(16).padStart(16, '0')
}

/** Deterministic contract id from its identity facts. */
export function deriveContractId(sessionId: SessionIdRef, goalSeq: number, seed: string | number): ContractId {
  return `${PREFIXES.contract}-${contentHash(sessionId, goalSeq, seed)}` as ContractId
}

/** Deterministic criterion id from contract + position index. */
export function deriveCriterionId(contractId: ContractId, index: number): CriterionId {
  return `${PREFIXES.criterion}-${contentHash(contractId, index)}` as CriterionId
}

/**
 * Deterministic evidence id from (contract, criterion, fact) triple.
 * Same fact re-observed or re-delivered produces the same evidence id.
 */
export function deriveEvidenceId(
  contractId: ContractId,
  criterionId: CriterionId | undefined,
  factKey: string,
): EvidenceId {
  return `${PREFIXES.evidence}-${contentHash(contractId, criterionId ?? '', factKey)}` as EvidenceId
}

/** Deterministic verification run id from (contract, revision, startedAt). */
export function deriveRunId(contractId: ContractId, contractRevision: number, startedAt: number): VerificationRunId {
  return `${PREFIXES.run}-${contentHash(contractId, contractRevision, startedAt)}` as VerificationRunId
}

/** Deterministic export id from (contract, createdAt). */
export function deriveExportId(contractId: ContractId, createdAt: number): ExportId {
  return `${PREFIXES.export}-${contentHash(contractId, createdAt)}` as ExportId
}

/** Criterion position reference used by commands and UIs: stable 1-based index. */
export function criterionLabel(contractId: ContractId, index: number): string {
  return `crit#${index + 1} (${deriveCriterionId(contractId, index)})`
}
