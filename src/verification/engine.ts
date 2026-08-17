/**
 * Verification engine (spec §7.4, §12): orchestrates passive observation,
 * optional active checks and registered providers into one durable
 * VerificationRun. Every criterion result keeps mechanical status and
 * evidence independent from user disposition and label strength.
 */

import { ok, type OutcomeResult } from '../domain/errors.ts'
import { deriveEvidenceId, deriveRunId, type ContractId, type CriterionId } from '../domain/ids.ts'
import { evidenceFreshness, type FreshnessContext } from '../domain/freshness.ts'
import { aggregateVerification } from '../domain/reducer.ts'
import type {
  AcceptanceCriterion,
  CriterionSpecification,
  EvidenceFact,
  SessionFactLog,
  SensitivityClass,
  TaskContract,
  TaskDisposition,
  VerificationResult,
  VerificationRun,
} from '../domain/types.ts'
import type { FactRegistry } from '../dsh/registry.ts'
import type { Repository, EvidenceRow } from '../persistence/repository.ts'
import { verifyActive } from './adapters/active.ts'
import { verifyPassive } from './adapters/passive.ts'
import { decideActiveRun, type PolicyContext } from './policy.ts'
import type { VerifierRegistry } from './registry.ts'

export interface EngineDeps {
  repository: Repository
  registry: FactRegistry
  verifiers: VerifierRegistry
  policy: PolicyContext
  now?: () => number
}

export interface VerifyInput {
  contract: TaskContract
  disposition?: TaskDisposition
  signal?: AbortSignal
}

/** Implied verdict of one evidence fact against one criterion spec. */
export function impliesVerdict(fact: EvidenceFact, spec: CriterionSpecification): 'pass' | 'fail' | 'unknown' {
  switch (fact.kind) {
    case 'command':
      if (spec.kind !== 'command-exit') return 'unknown'
      return fact.exitCode === spec.expectExitCode ? 'pass' : 'fail'
    case 'test-report':
      if (spec.kind !== 'test-report') return 'unknown'
      if (fact.failed > spec.maxFailed) return 'fail'
      if (fact.passed >= spec.minPassed) return 'pass'
      return 'unknown'
    case 'file-state':
      if (spec.kind === 'file-exists') return fact.exists ? 'pass' : 'fail'
      if (spec.kind === 'file-absent') return fact.exists ? 'fail' : 'pass'
      if (spec.kind === 'file-digest' && fact.digest !== undefined) {
        return fact.digest === spec.digest ? 'pass' : 'fail'
      }
      return 'unknown'
    case 'git-scope':
      if (spec.kind !== 'git-scope') return 'unknown'
      return fact.violations.length === 0 ? 'pass' : 'fail'
    case 'diagnostic-count':
      if (spec.kind !== 'diagnostic-count') return 'unknown'
      if (fact.errors > spec.maxErrors || fact.warnings > spec.maxWarnings) return 'fail'
      return 'pass'
    case 'user-confirmation':
      if (spec.kind !== 'manual') return 'unknown'
      if (fact.disposition === 'accepted') return 'pass'
      if (fact.disposition === 'rejected' || fact.disposition === 'revised') return 'fail'
      return 'unknown'
    case 'verifier':
      return fact.verdict
    case 'turn':
    case 'usage':
    case 'feedback':
    case 'tool-outcome':
      return 'unknown'
  }
}

const SENSITIVITY_OF: Record<EvidenceFact['kind'], SensitivityClass> = {
  command: 'confidential',
  'test-report': 'internal',
  'file-state': 'confidential',
  'git-scope': 'internal',
  'diagnostic-count': 'internal',
  turn: 'public',
  usage: 'public',
  'user-confirmation': 'personal-data',
  feedback: 'internal',
  'tool-outcome': 'internal',
  verifier: 'internal',
}

/** Manual criteria resolve through user disposition (medium evidence). */
function manualVerdict(criterion: AcceptanceCriterion, disposition: TaskDisposition | undefined) {
  const status = disposition?.status ?? 'none'
  const fact: EvidenceFact = {
    kind: 'user-confirmation',
    disposition: status,
    ...(disposition?.noteRef === undefined ? {} : { noteRef: disposition.noteRef }),
  }
  switch (status) {
    case 'accepted':
      return { status: 'pass' as const, facts: [fact], conflict: false, note: undefined }
    case 'rejected':
    case 'revised':
      return { status: 'fail' as const, facts: [fact], conflict: false, note: `user disposition: ${status}` }
    case 'abandoned':
      return { status: 'not-applicable' as const, facts: [], conflict: false, note: 'user abandoned the task' }
    case 'none':
      return { status: 'unknown' as const, facts: [], conflict: false, note: 'awaiting user disposition (accept/reject)' }
  }
}

/** Run one criterion end to end; returns its result plus new evidence rows. */
async function verifyCriterion(
  contract: TaskContract,
  criterion: AcceptanceCriterion,
  log: SessionFactLog | undefined,
  disposition: TaskDisposition | undefined,
  prior: readonly EvidenceRow[],
  deps: EngineDeps,
  signal?: AbortSignal,
): Promise<{ result: VerificationResult; rows: EvidenceRow[] }> {
  const now = deps.now?.() ?? Date.now()
  const ctx: FreshnessContext = {
    capturedContractRevision: contract.revision,
    currentContractRevision: contract.revision,
    currentWorkspaceEpoch: log?.workspaceEpoch,
    verifierVersion: deps.policy.verifierVersion,
    capturedVerifierVersion: deps.policy.verifierVersion,
    now,
  }

  // 1. Gather candidate facts: passive + manual (+ active/custom when allowed).
  let verdict: { status: 'pass' | 'fail' | 'unknown' | 'not-applicable'; facts: EvidenceFact[]; conflict: boolean; note?: string }
  let activeFact: EvidenceFact | undefined
  let activeSensitivity: SensitivityClass = 'internal'

  if (criterion.specification.kind === 'manual') {
    verdict = manualVerdict(criterion, disposition)
  } else if (criterion.specification.kind === 'custom') {
    const provider = deps.verifiers.get(criterion.specification.providerId)
    if (provider === undefined) {
      verdict = { status: 'unknown', facts: [], conflict: false, note: `custom verifier '${criterion.specification.providerId}' is not registered` }
    } else {
      const decision = decideActiveRun(contract, provider.id, deps.policy)
      if (!decision.allowed) {
        verdict = { status: 'unknown', facts: [], conflict: false, note: `custom verifier '${provider.id}' blocked: ${decision.reason}` }
      } else {
        try {
          const output = await provider.run(
            { criterion, workspaceRoot: contract.scope.workspaceRoot, config: { commandTimeoutMs: contract.verificationPolicy.commandTimeoutMs, maxCommandOutputBytes: contract.verificationPolicy.maxCommandOutputBytes }, params: criterion.specification.params },
            signal,
          )
          activeFact = output.fact
          activeSensitivity = output.sensitivity
          const implied = impliesVerdict(output.fact, criterion.specification)
          verdict = { status: implied, facts: [output.fact], conflict: false, note: implied === 'unknown' ? 'provider returned an unknown verdict' : undefined }
        } catch (error) {
          verdict = { status: 'unknown', facts: [], conflict: false, note: `custom verifier failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }
  } else {
    // Passive observation first — never rerun anything just to get a label.
    verdict = verifyPassive(criterion, log, prior)
    if (verdict.status === 'unknown') {
      const decision = decideActiveRun(contract, criterion.kind, deps.policy)
      if (decision.allowed) {
        try {
          const outcome = await verifyActive(criterion.specification, decision.options)
          activeFact = outcome.fact
          activeSensitivity = outcome.sensitivity
          verdict = { status: outcome.status, facts: [outcome.fact], conflict: false, note: outcome.note }
        } catch (error) {
          verdict = { status: 'unknown', facts: [], conflict: false, note: `active verification failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      } else if (verdict.note !== undefined) {
        // Keep the passive note (it already explains why).
      }
    }
  }

  // 2. Persist new evidence rows (deterministic ids, idempotent).
  const rows: EvidenceRow[] = []
  for (const fact of verdict.facts) {
    const id = deriveEvidenceId(contract.id, criterion.id, JSON.stringify(fact))
    const row: EvidenceRow = {
      schemaVersion: 1,
      id,
      contractId: contract.id,
      criterionId: criterion.id,
      source: 'verifier',
      sourceRef: undefined,
      observedAt: now,
      workspaceState: { epoch: log?.workspaceEpoch ?? 0 },
      fact,
      strength: fact.kind === 'user-confirmation' ? 'medium' : 'strong',
      sensitivity: fact === activeFact ? activeSensitivity : SENSITIVITY_OF[fact.kind],
      contractRevision: contract.revision,
      verifierVersion: deps.policy.verifierVersion,
    }
    rows.push(row)
    await deps.repository.putEvidence(row)
  }

  // 3. Freshness over prior + new rows for this criterion.
  const candidates: { row: EvidenceRow; freshness: ReturnType<typeof evidenceFreshness> }[] = []
  for (const row of prior) {
    if (row.criterionId !== criterion.id) continue
    ctx.capturedContractRevision = row.contractRevision
    ctx.capturedVerifierVersion = row.verifierVersion
    candidates.push({ row, freshness: evidenceFreshness(row, criterion.freshness, ctx) })
  }
  ctx.capturedContractRevision = contract.revision
  ctx.capturedVerifierVersion = deps.policy.verifierVersion
  for (const row of rows) {
    candidates.push({ row, freshness: evidenceFreshness(row, criterion.freshness, ctx) })
  }

  // 4. Combine into a criterion result (rule 6: conflicts → inconclusive).
  const fresh = candidates.filter((c) => c.freshness === 'fresh')
  const staleIds = candidates.filter((c) => c.freshness === 'stale').map((c) => c.row.id)
  const passRows = fresh.filter((c) => impliesVerdict(c.row.fact, criterion.specification) === 'pass')
  const failRows = fresh.filter((c) => impliesVerdict(c.row.fact, criterion.specification) === 'fail')

  let status: VerificationResult['status']
  let conflict = false
  let note = verdict.note
  if (fresh.length === 0) {
    status = staleIds.length > 0 ? 'unknown' : verdict.status
    if (staleIds.length > 0) note = 'all evidence is stale — re-verify after the workspace changed'
  } else if (passRows.length > 0 && failRows.length > 0) {
    status = 'unknown'
    conflict = true
    note = 'conflicting evidence: pass and fail are both currently supported'
  } else if (passRows.length > 0) {
    status = 'pass'
    note = undefined
  } else if (failRows.length > 0) {
    status = 'fail'
    note = note ?? 'criterion failed'
  } else {
    status = 'unknown'
  }

  const evidenceIds = [...new Set([...passRows, ...failRows, ...fresh].map((c) => c.row.id))]
  const result: VerificationResult = {
    criterionId: criterion.id,
    status,
    evidenceIds,
    staleEvidenceIds: staleIds,
    conflict,
    ...(note === undefined ? {} : { note }),
  }
  return { result, rows }
}

/** Verify a whole contract and persist one VerificationRun. */
export async function verifyContract(input: VerifyInput, deps: EngineDeps): Promise<OutcomeResult<VerificationRun>> {
  const { contract } = input
  const startedAt = deps.now?.() ?? Date.now()
  const log = deps.registry.getLog(contract.sessionId)
  const prior = deps.repository.listEvidence(contract.id)
  const disposition = deps.repository.getDisposition(contract.id)

  const results: VerificationResult[] = []
  const newRows: EvidenceRow[] = []
  for (const criterion of contract.criteria) {
    const { result, rows } = await verifyCriterion(contract, criterion, log, disposition, prior, deps, input.signal)
    results.push(result)
    newRows.push(...rows)
  }

  const aggregate = aggregateVerification(results, contract.criteria)
  const run: VerificationRun = {
    schemaVersion: 1,
    id: deriveRunId(contract.id, contract.revision, startedAt),
    contractId: contract.id,
    contractRevision: contract.revision,
    startedAt,
    finishedAt: deps.now?.() ?? Date.now(),
    results,
    status: aggregate.status,
    labelStrength: evidenceLabelStrength(results, [...prior, ...newRows], contract),
    reasons: aggregate.reasons,
    source: 'passive',
  }
  await deps.repository.putRun(run)
  return ok(run)
}

/**
 * Label strength from the actual evidence backing a passing aggregate
 * (spec §7.4 rules 8–9): user acceptance is medium, a judge is weak at most,
 * deterministic mechanical evidence is strong.
 */
export function evidenceLabelStrength(
  results: readonly VerificationResult[],
  rows: readonly EvidenceRow[],
  contract: TaskContract,
): 'strong' | 'medium' | 'weak' | 'unknown' {
  const byId = new Map(contract.criteria.map((c) => [c.id, c]))
  const relevant = results.filter((r) => {
    const criterion = byId.get(r.criterionId)
    return criterion !== undefined && criterion.required && r.status === 'pass'
  })
  const evidenceIds = new Set(relevant.flatMap((r) => r.evidenceIds))
  const strengths = rows.filter((row) => evidenceIds.has(row.id)).map((row) => row.strength)
  if (strengths.length === 0) return 'unknown'
  if (strengths.some((s) => s === 'weak')) return 'weak'
  if (strengths.some((s) => s === 'medium')) return 'medium'
  return 'strong'
}

export type { ContractId, CriterionId }
