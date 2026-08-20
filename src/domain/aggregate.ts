/**
 * Aggregate helpers for Task Contracts (spec §7.1): validation, revision,
 * criterion lookup, and fact-log reduction. Pure domain.
 */

import { isAbsolute } from 'node:path'

import { err, ok, type OutcomeResult } from './errors.ts'
import { contentHash, deriveContractId, deriveContractIdFromExternalKey, deriveCriterionId, type ContractId, type CriterionId } from './ids.ts'
import type {
  AcceptanceCriterion,
  CriterionSpecification,
  SessionFact,
  SessionFactLog,
  TaskContract,
  TaskScope,
  VerificationResult,
} from './types.ts'

export interface CreateContractInput {
  sessionId: string
  /** Seq of the user/message (or turn/start) event carrying the goal. */
  goalSeq?: number
  goalText?: string
  /**
   * External idempotency key. When present the caller promises to re-send the
   * SAME key on retry; the contract id is then deterministically derived from
   * `(sessionId, externalKey)` so the key→contract relation is atomic by
   * construction (see `createOrGetContract`). Absent ⇒ legacy `createContract`
   * id derivation from `(sessionId, goalSeq, seed)`.
   */
  externalKey?: string
  workspaceRoot?: string
  criteria?: readonly NewCriterionInput[]
  verificationPolicy?: Partial<TaskContract['verificationPolicy']>
  privacyPolicy?: Partial<TaskContract['privacyPolicy']>
  constraints?: readonly { id: string; description: string }[]
  createdAt?: number
}

export interface NewCriterionInput {
  description: string
  kind: CriterionSpecification['kind']
  specification: CriterionSpecification
  required?: boolean
  severity?: 'blocking' | 'warning'
  freshness?: AcceptanceCriterion['freshness']
}

/**
 * Validate a scope; rejects empty roots and non-absolute roots.
 *
 * Absolute-ness is determined by Node's platform-aware `path.isAbsolute`,
 * not by POSIX-only `startsWith('/')` (DEP-01). This means:
 *   - on POSIX: `/root/repo` is accepted; `/foo`, `/Users/x` are accepted;
 *     `relative/path`, `./x`, `~/x` are rejected;
 *   - on Windows: `C:\repo`, `C:/repo`, `D:\path\to\repo` are accepted;
 *     `relative\path`, `repo`, `C:relative` are rejected.
 *
 * The empty string is the sentinel for "no workspace root" (consistent with
 * `verification/policy.ts:64`) and is accepted as before.
 */
export function validateScope(scope: TaskScope): OutcomeResult<TaskScope> {
  if (scope.workspaceRoot !== '' && !isAbsolute(scope.workspaceRoot)) {
    return err('invalid-input', 'workspaceRoot must be an absolute path or empty')
  }
  if (!scope.allowActiveVerification) {
    // Active verification may only be enabled by trusted configuration, never
    // by contract input alone — the service enforces this again at runtime.
    return ok(scope)
  }
  return ok(scope)
}

export function buildContract(input: CreateContractInput): OutcomeResult<TaskContract> {
  if (!input.sessionId || input.sessionId.length === 0) {
    return err('invalid-input', 'sessionId is required')
  }
  const goalText = input.goalText?.trim() ?? ''
  if (goalText.length === 0 && input.goalSeq === undefined) {
    return err('invalid-input', 'a goal reference (goalSeq) or explicit goal text is required')
  }
  const goal = input.goalSeq !== undefined
    ? { kind: 'reference' as const, ref: { sessionId: input.sessionId, seq: input.goalSeq } }
    : { kind: 'explicit' as const, text: goalText }

  const createdAt = input.createdAt ?? Date.now()
  // Deterministic id: same session + same goal ⇒ same contract (duplicate
  // detection works); explicit goal text is hashed, never stored verbatim.
  // When the caller supplies an `externalKey`, the id is derived from that
  // key instead (session + key), so every retry of the same key resolves to
  // the same contract regardless of the `createdAt` clock/seed — this is the
  // crash-safe idempotency seam `createOrGetContract` relies on.
  const id = input.externalKey !== undefined && input.externalKey.length > 0
    ? deriveContractIdFromExternalKey(input.sessionId, input.externalKey)
    : deriveContractId(input.sessionId, input.goalSeq ?? -1, goalText.length > 0 ? contentHash(goalText) : createdAt)
  const criteria = buildCriteria(id, input.criteria ?? [])

  const contract: TaskContract = {
    schemaVersion: 1,
    id,
    revision: 1,
    sessionId: input.sessionId,
    goal,
    ...(input.externalKey !== undefined && input.externalKey.length > 0 ? { externalKey: input.externalKey } : {}),
    scope: {
      workspaceRoot: input.workspaceRoot ?? '',
      pathPrefixes: [],
      allowActiveVerification: false,
    },
    constraints: input.constraints ?? [],
    criteria,
    verificationPolicy: {
      autoRun: false,
      commandTimeoutMs: 120000,
      maxCommandOutputBytes: 65536,
      allowedVerifierIds: [],
      ...(input.verificationPolicy ?? {}),
    },
    privacyPolicy: {
      dataEligibility: 'private-only',
      exportAllowed: true,
      contentIncluded: false,
      ...(input.privacyPolicy ?? {}),
    },
    createdAt,
    updatedAt: createdAt,
  }
  const scopeResult = validateScope(contract.scope)
  if (!scopeResult.ok) return scopeResult
  return ok(contract)
}

function buildCriteria(contractId: ContractId, inputs: readonly NewCriterionInput[]): readonly AcceptanceCriterion[] {
  return inputs.map((input, index) => {
    const id = deriveCriterionId(contractId, index)
    return {
      id,
      description: input.description.trim() || specificationLabel(input.specification),
      kind: input.specification.kind,
      required: input.required ?? true,
      severity: input.severity ?? 'blocking',
      specification: input.specification,
      freshness: input.freshness ?? defaultFreshness(input.specification.kind),
    }
  })
}

/** Default freshness policy per kind (deterministic, conservative). */
export function defaultFreshness(kind: CriterionSpecification['kind']): AcceptanceCriterion['freshness'] {
  switch (kind) {
    case 'file-exists':
    case 'file-absent':
    case 'file-digest':
    case 'json-schema':
    case 'git-scope':
    case 'test-report':
      return { invalidateOnWorkspaceChange: true }
    default:
      return { invalidateOnWorkspaceChange: false }
  }
}

function specificationLabel(spec: CriterionSpecification): string {
  switch (spec.kind) {
    case 'command-exit':
      return `command exits ${spec.expectExitCode}: ${spec.command}`
    case 'test-report':
      return `tests pass (min ${spec.minPassed} passed, max ${spec.maxFailed} failed)`
    case 'file-exists':
      return `file exists: ${spec.path}`
    case 'file-absent':
      return `file absent: ${spec.path}`
    case 'file-digest':
      return `file digest matches: ${spec.path}`
    case 'json-schema':
      return `file satisfies schema: ${spec.path}`
    case 'git-scope':
      return 'changes stay within allowed git scope'
    case 'diagnostic-count':
      return `diagnostics within limits: ${spec.command}`
    case 'manual':
      return spec.prompt
    case 'custom':
      return `custom verifier: ${spec.providerId}`
  }
}

/**
 * Enterprise policy constraints (spec §5.2, §11). Policy lives ONLY in the
 * deployment config (the same trusted channel as autoRun) — repo/workspace
 * content can never set or relax it. Enforcement is pure: the service passes
 * the resolved constraints in, this function returns a business error.
 */
export interface EnterprisePolicyConstraints {
  /** Only enforced when the deployment mode is 'enterprise'. */
  active: boolean
  requireCriteria: boolean
  minCriteria: number
  mustIncludeKinds: readonly string[]
  /** Non-empty ⇒ contract verifier allowlists may not contain other ids. */
  allowedVerifierIds: readonly string[]
}

export function enforceEnterprisePolicy(
  contract: TaskContract,
  policy: EnterprisePolicyConstraints,
): OutcomeResult<void> {
  if (!policy.active) return ok(undefined)
  if (policy.requireCriteria && contract.criteria.length < policy.minCriteria) {
    return err('policy-denied', `enterprise policy requires at least ${policy.minCriteria} acceptance criteria, got ${contract.criteria.length}`)
  }
  const kinds = new Set(contract.criteria.map((c) => c.kind))
  for (const required of policy.mustIncludeKinds) {
    if (!kinds.has(required as AcceptanceCriterion['kind'])) {
      return err('policy-denied', `enterprise policy requires a '${required}' criterion`)
    }
  }
  if (policy.allowedVerifierIds.length > 0) {
    const extra = contract.verificationPolicy.allowedVerifierIds.filter((id) => !policy.allowedVerifierIds.includes(id))
    if (extra.length > 0) {
      return err('policy-denied', `enterprise policy forbids verifier ids: ${extra.join(', ')}`)
    }
  }
  return ok(undefined)
}

/** Revise a contract: bump revision, replace criteria/policy, keep identity. */
export function reviseContract(
  contract: TaskContract,
  patch: { criteria?: readonly NewCriterionInput[]; constraints?: readonly { id: string; description: string }[]; verificationPolicy?: Partial<TaskContract['verificationPolicy']>; privacyPolicy?: Partial<TaskContract['privacyPolicy']>; scope?: Partial<TaskScope> },
): OutcomeResult<TaskContract> {
  const next: TaskContract = {
    ...contract,
    revision: contract.revision + 1,
    scope: {
      ...contract.scope,
      ...(patch.scope ?? {}),
    },
    constraints: patch.constraints ?? contract.constraints,
    criteria: patch.criteria !== undefined ? buildCriteria(contract.id, patch.criteria) : contract.criteria,
    verificationPolicy: { ...contract.verificationPolicy, ...(patch.verificationPolicy ?? {}) },
    privacyPolicy: { ...contract.privacyPolicy, ...(patch.privacyPolicy ?? {}) },
    updatedAt: Date.now(),
  }
  const scopeResult = validateScope(next.scope)
  if (!scopeResult.ok) return scopeResult
  return ok(next)
}

export function criterionById(contract: TaskContract, id: CriterionId): AcceptanceCriterion | undefined {
  return contract.criteria.find((c) => c.id === id)
}

export function findCriterion(contract: TaskContract, idOrIndex: string): AcceptanceCriterion | undefined {
  const byId = criterionById(contract, idOrIndex as CriterionId)
  if (byId) return byId
  const index = Number(idOrIndex)
  if (Number.isInteger(index) && index >= 1 && index <= contract.criteria.length) {
    return contract.criteria[index - 1]
  }
  return undefined
}

/** Effective workspace epoch from a fact log: 0 when nothing observed. */
export function workspaceEpochOf(log: SessionFactLog | undefined): number | undefined {
  return log === undefined ? undefined : log.workspaceEpoch
}

/** Latest turn-end fact (reason) for a session, if any. */
export function latestTurnReason(log: SessionFactLog | undefined): { turn: number; reasonKind: string; seq: number } | undefined {
  if (log === undefined) return undefined
  let latest: { turn: number; reasonKind: string; seq: number } | undefined
  for (const fact of log.facts) {
    if (fact.kind === 'turn-end') {
      latest = { turn: fact.turn, reasonKind: fact.reasonKind, seq: fact.seq }
    }
  }
  return latest
}

/** Execution status from the fact log (spec §7 axes). */
export function executionStatusOf(log: SessionFactLog | undefined): 'active' | 'ended' | 'aborted' | 'blocked' {
  const turn = latestTurnReason(log)
  if (turn === undefined) return 'active'
  switch (turn.reasonKind) {
    case 'completed':
      return 'ended'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'blocked'
    case 'error':
    case 'max-tokens':
    case 'interrupted':
    default:
      return 'ended'
  }
}

/** Append a fact to a fact log snapshot, maintaining seq bounds and epoch. */
export function appendFact(log: SessionFactLog, fact: SessionFact): SessionFactLog {
  const facts = [...log.facts, fact]
  let workspaceEpoch = log.workspaceEpoch
  if (fact.kind === 'file-change-marker') workspaceEpoch += 1
  return {
    sessionId: log.sessionId,
    facts,
    seqStart: log.facts.length === 0 ? fact.seq : log.seqStart,
    seqEnd: fact.seq,
    workspaceEpoch,
  }
}

/** Keep only the newest N facts of each kind (bounded memory for huge sessions). */
export function boundedFacts(log: SessionFactLog, limit: number): SessionFactLog {
  if (log.facts.length <= limit) return log
  const byKind = new Map<string, SessionFact[]>()
  for (const fact of log.facts) {
    const key = fact.kind
    const list = byKind.get(key) ?? []
    list.push(fact)
    byKind.set(key, list)
  }
  const kept: SessionFact[] = []
  for (const list of byKind.values()) {
    kept.push(...list.slice(-limit))
  }
  kept.sort((a, b) => a.seq - b.seq)
  return { ...log, facts: kept }
}

/** Deterministic result set bookkeeping used by the engine. */
export function evidenceIdsOf(results: readonly VerificationResult[], criterionId: CriterionId): readonly string[] {
  return results.find((r) => r.criterionId === criterionId)?.evidenceIds ?? []
}
