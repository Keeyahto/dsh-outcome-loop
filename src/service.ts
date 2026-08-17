/**
 * OutcomeLoopService (spec §10): the public Host API. All mutations carry
 * explicit ownership, revision and idempotency semantics; business failures
 * return discriminated OutcomeError unions; infrastructure failures reject.
 * Outputs are detached, immutable snapshots. After disposal begins, new
 * mutations are rejected (`plugin-disposed`) and accepted work drains before
 * the storage domain closes.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { buildContract, findCriterion, reviseContract, workspaceEpochOf, executionStatusOf, type CreateContractInput, type NewCriterionInput } from './domain/aggregate.ts'
import { err, infrastructureError, ok, type OutcomeResult } from './domain/errors.ts'
import type { ContractId, CriterionId, EvidenceId, ExportId, VerificationRunId } from './domain/ids.ts'
import { deriveExportId, contentHash } from './domain/ids.ts'
import type { Evidence, ExportManifest, TaskContract, TaskDisposition, TaskOutcomeView, UserDispositionStatus, VerificationRun, SessionFactLog } from './domain/types.ts'
import { usageFromFacts, routesFromFacts } from './dsh/token-bridge.ts'
import { buildExportPreview } from './export/preview.ts'
import { buildExportContent } from './export/jsonl.ts'
import type { ConfigType } from './config.ts'
import { configDigest } from './config.ts'
import { createRepository, type Repository } from './persistence/repository.ts'
import { outcomeDomainSpec } from './persistence/schema.ts'
import { SessionQueue } from './persistence/queue.ts'
import { repairIndexes } from './persistence/repair.ts'
import { FactRegistry } from './dsh/registry.ts'
import { mountObserver, type ReplayDeps } from './dsh/observer.ts'
import { verifyContract } from './verification/engine.ts'
import { VerifierRegistry } from './verification/registry.ts'
import type { PolicyContext } from './verification/policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    outcomeLoop: OutcomeLoopService
  }
}

export interface OutcomeLoopApi {
  createContract(input: CreateContractInput): Promise<OutcomeResult<TaskContract>>
  reviseContract(ref: ContractRef, patch: ReviseContractInput): Promise<OutcomeResult<TaskContract>>
  addCriterion(contractId: ContractId, input: NewCriterionInput): Promise<OutcomeResult<TaskContract>>
  getContract(id: ContractId): Promise<OutcomeResult<TaskContract>>
  listContracts(query: ContractQuery): Promise<OutcomeResult<readonly TaskContract[]>>
  recordEvidence(input: RecordEvidenceInput): Promise<OutcomeResult<Evidence>>
  verify(input: VerifyInput): Promise<OutcomeResult<VerificationRun>>
  setDisposition(input: SetDispositionInput): Promise<OutcomeResult<TaskDisposition>>
  getOutcome(id: ContractId): Promise<OutcomeResult<TaskOutcomeView>>
  previewExport(input: ExportRequest): Promise<OutcomeResult<ExportPreviewResult>>
  exportJsonl(input: ApprovedExportRequest): Promise<OutcomeResult<ExportReceipt>>
  listExports(contractId: ContractId): Promise<OutcomeResult<readonly ExportManifest[]>>
  recordDecisionEvidence(input: RecordDecisionEvidenceInput): Promise<OutcomeResult<Evidence>>
  deleteOutcome(input: DeleteOutcomeRequest): Promise<OutcomeResult<DeleteOutcomeReceipt>>
  registerVerifier(provider: VerifierProviderLike): () => void
}

export interface ContractRef {
  contractId: ContractId
  expectedRevision: number
}

export interface ReviseContractInput {
  criteria?: readonly NewCriterionInput[]
  constraints?: readonly { id: string; description: string }[]
}

export interface ContractQuery {
  sessionId?: string
  limit?: number
}

export interface RecordEvidenceInput {
  contractId: ContractId
  criterionId?: string
  fact: Evidence['fact']
  source: Evidence['source']
  strength: Evidence['strength']
  sensitivity: Evidence['sensitivity']
  observedAt?: number
}

export interface VerifyInput {
  contractId: ContractId
  signal?: AbortSignal
}

export interface SetDispositionInput {
  contractId: ContractId
  status: Exclude<UserDispositionStatus, 'none'>
  expectedDispositionRevision?: number
  noteRef?: { sessionId: string; seq: number }
}

export interface ExportRequest {
  contractId: ContractId
}

export interface RecordDecisionEvidenceInput {
  contractId: ContractId
  source: 'dsh-code-reference' | string
  decisionId: string
  strategy: 'reuse' | 'adapt' | 'dependency' | 'rewrite'
  candidateRef?: string
  predictedMatch?: number
  predictedEffort?: { files: number; lines: string }
  policyDigest?: string
}

export interface ApprovedExportRequest extends ExportRequest {
  /** The digest from previewExport; content must be unchanged. */
  previewDigest: string
}

export interface ExportReceipt {
  manifest: ExportManifest
  /** The export content (JSONL). The caller owns writing it to disk. */
  content: string
}

export interface DeleteOutcomeRequest {
  contractId: ContractId
  /** Safety: the caller must confirm deletion of sidecar data. */
  confirmed: boolean
}

export interface DeleteOutcomeReceipt {
  deleted: {
    contracts: number
    evidence: number
    runs: number
    dispositions: number
    cursors: number
    exports: number
  }
  /** The canonical DSH session log is untouched by design. */
  sessionLogUntouched: true
}

export interface ExportPreviewResult {
  previewDigest: string
  recordCount: number
  fieldManifest: readonly string[]
  sensitivityHits: ExportManifest['sensitivityHits']
  warnings: readonly string[]
  /** Deterministic sample content for inspection (may be large; capped). */
  contentExcerpt: string
}

export interface VerifierProviderLike {
  id: string
  kinds: readonly string[]
  observesOnly: boolean
  executesCommands: boolean
  networkAccess: boolean
  producesStrength: 'strong' | 'medium'
  run(input: { criterion: TaskContract['criteria'][number]; workspaceRoot: string; config: { commandTimeoutMs: number; maxCommandOutputBytes: number }; params: unknown }, signal?: AbortSignal): Promise<{ fact: Evidence['fact']; strength: 'strong' | 'medium'; sensitivity: Evidence['sensitivity'] }>
}

export interface OutcomeLoopServiceOptions {
  config: ConfigType
  domain: Domain<typeof outcomeDomainSpec>
  ctx: Context
  version: string
  dshVersion: string | undefined
  trustedEnv: Readonly<Record<string, string>>
}

export class OutcomeLoopService extends Service {
  static inject = ['storageDomain']

  readonly repository: Repository
  readonly registry: FactRegistry
  readonly verifiers = new VerifierRegistry()

  private readonly queue = new SessionQueue()
  private readonly contractSessions = new Set<string>()
  private disposed = false
  private readonly disposeWaiters: (() => void)[] = []
  private readonly options: OutcomeLoopServiceOptions
  private readonly policy: PolicyContext
  private readonly version: string
  private readonly dshVersion: string | undefined
  private readonly sessionPersistence: SessionPersistence | undefined

  constructor(ctx: Context, options: OutcomeLoopServiceOptions) {
    super(ctx, 'outcomeLoop')
    this.options = options
    this.version = options.version
    this.dshVersion = options.dshVersion
    this.repository = createRepository(options.domain)
    this.registry = new FactRegistry()
    this.policy = {
      deploymentAutoRun: options.config.verification.autoRun,
      trustedEnv: options.trustedEnv,
      verifierVersion: `${options.version}+${configDigest(options.config)}`,
    }

    // Restore contract session membership + cursors.
    for (const contract of this.repository.listContracts()) {
      this.contractSessions.add(contract.sessionId)
    }
    for (const cursor of this.repository.listCursors()) {
      this.registry.seedCursor(cursor.sessionId, cursor.lastSeq)
    }

    // Startup repair of derived indexes + opt-in retention (spec §8.4).
    void repairIndexes(this.repository, { evidenceMaxAgeMs: options.config.retention.evidenceMaxAgeMs }).catch((error) => {
      this.log('warn', `outcome-loop: index repair failed: ${error instanceof Error ? error.message : String(error)}`)
    })

    // Observation + replay (spec §8.2, §8.3).
    this.sessionPersistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
    const sessionPersistence = this.sessionPersistence
    const deps: ReplayDeps = {
      ctx,
      registry: this.registry,
      repository: this.repository,
      queue: this.queue,
      hasContract: (sessionId) => this.contractSessions.has(sessionId),
      logger: { warn: (message, ...args) => this.log('warn', message, ...args) },
      sessionPersistence,
    }
    this.ctx.effect(() => mountObserver(deps))

    // Disposal: stop accepting mutations, drain queues, close the domain.
    this.ctx.effect(() => async () => {
      this.disposed = true
      await this.queue.drain()
      for (const waiter of this.disposeWaiters) waiter()
      await options.domain.close()
    })
  }

  private assertMutable(): OutcomeResult<void> {
    if (this.disposed) {
      return err('plugin-disposed', 'outcome-loop is disposed; mutations are rejected')
    }
    return ok(undefined)
  }

  private log(level: 'info' | 'warn', message: string, ...args: unknown[]): void {
    if (this.options.config.logging.level === 'debug' || level === 'warn') {
      this.ctx.logger?.[level]?.(message, ...args)
    }
  }

  private async serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.enqueue({
        sessionId,
        run: async () => {
          try {
            resolve(await fn())
          } catch (error) {
            reject(error)
          }
        },
      })
    })
  }

  // ═══ Contracts ═══

  async createContract(input: CreateContractInput): Promise<OutcomeResult<TaskContract>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    try {
      const built = buildContract(input)
      if (!built.ok) return built
      const existing = this.repository.getContract(built.value.id)
      if (existing !== undefined) {
        return err('invalid-input', 'a contract with the same id already exists — revise it instead')
      }
      await this.serialized(built.value.sessionId, async () => {
        await this.repository.putContract(built.value)
      })
      this.contractSessions.add(built.value.sessionId)
      return ok(this.repository.getContract(built.value.id) as TaskContract)
    } catch (error) {
      throw infrastructureError(error, 'createContract')
    }
  }

  async reviseContract(ref: ContractRef, patch: ReviseContractInput): Promise<OutcomeResult<TaskContract>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    try {
      const current = this.repository.getContract(ref.contractId)
      if (current === undefined) return err('contract-not-found', 'no such contract')
      const revised = reviseContract(current, patch)
      if (!revised.ok) return revised
      const applied = await this.repository.updateContract(ref.contractId, revised.value, ref.expectedRevision)
      if (!applied) {
        const latest = this.repository.getContract(ref.contractId)
        return err('contract-revision-conflict', `contract revision moved (expected ${ref.expectedRevision}, current ${latest?.revision ?? 'deleted'})`)
      }
      return ok(this.repository.getContract(ref.contractId) as TaskContract)
    } catch (error) {
      throw infrastructureError(error, 'reviseContract')
    }
  }

  async addCriterion(contractId: ContractId, input: NewCriterionInput): Promise<OutcomeResult<TaskContract>> {
    const current = this.repository.getContract(contractId)
    if (current === undefined) return err('contract-not-found', 'no such contract')
    return this.reviseContract({ contractId, expectedRevision: current.revision }, { criteria: [...current.criteria.map(toNewCriterion), input] })
  }

  async getContract(id: ContractId): Promise<OutcomeResult<TaskContract>> {
    const contract = this.repository.getContract(id)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    return ok(contract)
  }

  async listContracts(query: ContractQuery): Promise<OutcomeResult<readonly TaskContract[]>> {
    const limit = Math.min(query.limit ?? 100, 500)
    let contracts = this.repository.listContracts()
    if (query.sessionId !== undefined) {
      contracts = contracts.filter((c) => c.sessionId === query.sessionId)
    }
    contracts.sort((a, b) => b.updatedAt - a.updatedAt)
    return ok(contracts.slice(0, limit))
  }

  // ═══ Evidence ═══

  async recordEvidence(input: RecordEvidenceInput): Promise<OutcomeResult<Evidence>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    const contract = this.repository.getContract(input.contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    if (input.criterionId !== undefined && findCriterion(contract, input.criterionId) === undefined) {
      return err('criterion-not-found', `no criterion '${input.criterionId}' on this contract`)
    }
    const observedAt = input.observedAt ?? Date.now()
    const row: Evidence & { contractRevision: number; verifierVersion: string } = {
      schemaVersion: 1,
      id: `ole-${contentHash(contract.id, input.criterionId ?? '', JSON.stringify(input.fact))}` as EvidenceId,
      contractId: contract.id,
      ...(input.criterionId === undefined ? {} : { criterionId: input.criterionId as CriterionId }),
      source: input.source,
      observedAt,
      workspaceState: { epoch: workspaceEpochOf(this.registry.getLog(contract.sessionId)) ?? 0 },
      fact: input.fact,
      strength: input.strength,
      sensitivity: input.sensitivity,
      contractRevision: contract.revision,
      verifierVersion: this.policy.verifierVersion,
    }
    try {
      await this.repository.putEvidence(row)
      return ok(this.repository.getEvidence(row.id) as Evidence)
    } catch (error) {
      throw infrastructureError(error, 'recordEvidence')
    }
  }

  // ═══ Verification ═══

  async verify(input: VerifyInput): Promise<OutcomeResult<VerificationRun>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    const contract = this.repository.getContract(input.contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    if (!this.options.config.verification.observeExisting && !this.options.config.verification.autoRun) {
      return err('policy-denied', 'verification is disabled by configuration')
    }
    try {
      // Cold session without observed facts: best-effort replay through the
      // optional session-persistence service (spec §8.3 rule 5).
      if (this.registry.getLog(contract.sessionId) === undefined && this.sessionPersistence !== undefined) {
        const { fillColdSession } = await import('./dsh/observer.ts')
        await fillColdSession(
          {
            ctx: this.ctx,
            registry: this.registry,
            repository: this.repository,
            queue: this.queue,
            hasContract: (sessionId) => this.contractSessions.has(sessionId),
            logger: { warn: (message, ...args) => this.log('warn', message, ...args) },
            sessionPersistence: this.sessionPersistence,
          },
          contract.sessionId,
        )
        await new Promise((resolve) => this.queue.enqueue({ sessionId: contract.sessionId, run: () => Promise.resolve().then(resolve) }))
      }
      return await verifyContract({ contract, signal: input.signal }, {
        repository: this.repository,
        registry: this.registry,
        verifiers: this.verifiers,
        policy: this.policy,
      })
    } catch (error) {
      throw infrastructureError(error, 'verify')
    }
  }

  // ═══ Disposition ═══

  async setDisposition(input: SetDispositionInput): Promise<OutcomeResult<TaskDisposition>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    const contract = this.repository.getContract(input.contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    const current = this.repository.getDisposition(input.contractId)
    const next: TaskDisposition = {
      contractId: input.contractId,
      status: input.status,
      revision: (current?.revision ?? 0) + 1,
      ...(input.noteRef === undefined ? {} : { noteRef: input.noteRef }),
      updatedAt: Date.now(),
    }
    try {
      if (current === undefined) {
        await this.repository.putDisposition(next)
      } else if (input.expectedDispositionRevision !== undefined && input.expectedDispositionRevision !== current.revision) {
        return err('contract-revision-conflict', `disposition revision moved (expected ${input.expectedDispositionRevision}, current ${current.revision})`)
      } else {
        const applied = await this.repository.updateDisposition(input.contractId, next, current.revision)
        if (!applied) return err('contract-revision-conflict', 'disposition revision moved concurrently')
      }
      return ok(this.repository.getDisposition(input.contractId) as TaskDisposition)
    } catch (error) {
      throw infrastructureError(error, 'setDisposition')
    }
  }

  // ═══ Outcome view ═══

  async getOutcome(id: ContractId): Promise<OutcomeResult<TaskOutcomeView>> {
    const contract = this.repository.getContract(id)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    const runs = this.repository.listRuns(id)
    const disposition = this.repository.getDisposition(id)
    const log = this.registry.getLog(contract.sessionId)
    const view: TaskOutcomeView = {
      contract,
      ...(runs.length > 0 ? { latestRun: runs[runs.length - 1] } : {}),
      disposition,
      executionStatus: executionStatusOf(log),
      labelStrength: runs.length > 0 ? runs[runs.length - 1]!.labelStrength : 'unknown',
    }
    return ok(view)
  }

  // ═══ Export ═══

  async previewExport(input: ExportRequest): Promise<OutcomeResult<ExportPreviewResult>> {
    const contract = this.repository.getContract(input.contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    if (!contract.privacyPolicy.exportAllowed) {
      return err('policy-denied', 'this contract does not allow export')
    }
    const runs = this.repository.listRuns(input.contractId)
    const disposition = this.repository.getDisposition(input.contractId)
    const log = this.registry.getLog(contract.sessionId)
    const usage = usageFromFacts(log)
    const routes = routesFromFacts(log)
    const preview = buildExportPreview(
      contract,
      runs.length > 0 ? runs[runs.length - 1] : undefined,
      disposition,
      log,
      this.repository,
      { outcomeLoopVersion: this.version, dshVersion: this.dshVersion, configDigest: configDigest(this.options.config) },
      usage,
      routes,
    )
    return ok({
      previewDigest: preview.contentDigest,
      recordCount: preview.recordCount,
      fieldManifest: preview.fieldManifest,
      sensitivityHits: preview.sensitivityHits,
      warnings: preview.warnings,
      contentExcerpt: preview.content.slice(0, 2000),
    })
  }

  async exportJsonl(input: ApprovedExportRequest): Promise<OutcomeResult<ExportReceipt>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    const contract = this.repository.getContract(input.contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    if (!contract.privacyPolicy.exportAllowed) {
      return err('policy-denied', 'this contract does not allow export')
    }
    // Recompute the preview; any change since approval invalidates it (§14.5).
    const preview = await this.previewExport({ contractId: input.contractId })
    if (!preview.ok) return preview
    if (preview.value.previewDigest !== input.previewDigest) {
      return err('export-approval-invalid', 'the export preview changed since approval — preview again and re-approve')
    }
    const manifest: ExportManifest = {
      id: deriveExportId(input.contractId, Date.now()),
      contractId: input.contractId,
      createdAt: Date.now(),
      recordCount: preview.value.recordCount,
      contentDigest: preview.value.previewDigest,
      fieldManifest: preview.value.fieldManifest,
      sensitivityHits: preview.value.sensitivityHits,
      redactionChanges: 0,
      license: contract.privacyPolicy.dataEligibility,
      schemaVersion: 'outcome-loop.export.v1',
      outcomeLoopVersion: this.version,
      dshVersion: this.dshVersion,
    }
    // Recompute the FULL content (the excerpt above is preview-only).
    const full = buildExportContent({
      contract,
      run: this.repository.listRuns(input.contractId).at(-1),
      disposition: this.repository.getDisposition(input.contractId),
      factLog: this.registry.getLog(contract.sessionId),
      usage: usageFromFacts(this.registry.getLog(contract.sessionId)),
      routes: routesFromFacts(this.registry.getLog(contract.sessionId)),
      outcomeLoopVersion: this.version,
      dshVersion: this.dshVersion,
      configDigest: configDigest(this.options.config),
    })
    if (full.contentDigest !== input.previewDigest) {
      return err('export-approval-invalid', 'the export content changed since approval — preview again and re-approve')
    }
    try {
      await this.repository.putExportManifest(manifest)
      return ok({ manifest, content: full.content })
    } catch (error) {
      throw infrastructureError(error, 'exportJsonl')
    }
  }

  // ═══ Prior-decision evidence (§15, dsh-code-reference integration) ═══

  async recordDecisionEvidence(input: RecordDecisionEvidenceInput): Promise<OutcomeResult<Evidence>> {
    return this.recordEvidence({
      contractId: input.contractId,
      source: 'import',
      strength: 'medium',
      sensitivity: 'internal',
      fact: {
        kind: 'decision',
        source: input.source,
        decisionId: input.decisionId,
        strategy: input.strategy,
        ...(input.candidateRef === undefined ? {} : { candidateRef: input.candidateRef }),
        ...(input.predictedMatch === undefined ? {} : { predictedMatch: input.predictedMatch }),
        ...(input.predictedEffort === undefined ? {} : { predictedEffort: input.predictedEffort }),
        ...(input.policyDigest === undefined ? {} : { policyDigest: input.policyDigest }),
      },
    })
  }

  async listExports(contractId: ContractId): Promise<OutcomeResult<readonly ExportManifest[]>> {
    const contract = this.repository.getContract(contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    return ok(this.repository.listExportManifests(contractId))
  }

  // ═══ Delete ═══

  async deleteOutcome(input: DeleteOutcomeRequest): Promise<OutcomeResult<DeleteOutcomeReceipt>> {
    const mutable = this.assertMutable()
    if (!mutable.ok) return mutable
    if (!input.confirmed) {
      return err('invalid-input', 'deletion requires confirmed: true')
    }
    const contract = this.repository.getContract(input.contractId)
    if (contract === undefined) return err('contract-not-found', 'no such contract')
    const receipt: DeleteOutcomeReceipt = {
      deleted: {
        contracts: 1,
        evidence: this.repository.listEvidence(input.contractId).length,
        runs: this.repository.listRuns(input.contractId).length,
        dispositions: this.repository.getDisposition(input.contractId) === undefined ? 0 : 1,
        cursors: this.repository.getCursor(contract.sessionId) === undefined ? 0 : 1,
        exports: this.repository.listExportManifests(input.contractId).length,
      },
      sessionLogUntouched: true,
    }
    try {
      await this.serialized(contract.sessionId, async () => {
        await this.repository.deleteEvidence(input.contractId)
        await this.repository.deleteRuns(input.contractId)
        await this.repository.deleteDisposition(input.contractId)
        await this.repository.deleteExportManifests(input.contractId)
        await this.repository.deleteContract(input.contractId)
        await this.repository.deleteCursor(contract.sessionId)
      })
      this.contractSessions.delete(contract.sessionId)
      this.registry.forget(contract.sessionId)
      return ok(receipt)
    } catch (error) {
      throw infrastructureError(error, 'deleteOutcome')
    }
  }

  // ═══ Verifier registry ═══

  registerVerifier(provider: VerifierProviderLike): () => void {
    return this.verifiers.register({
      id: provider.id,
      kinds: provider.kinds as never,
      observesOnly: provider.observesOnly,
      executesCommands: provider.executesCommands,
      networkAccess: provider.networkAccess,
      producesStrength: provider.producesStrength,
      run: provider.run as never,
    })
  }

  // ═══ Diagnostics ═══

  /** Internal diagnostics; not a business API. */
  get diagnostics(): { sessions: number; contractSessions: number; verifiers: number; pendingQueueLoad: number; disposed: boolean } {
    return {
      sessions: this.registry.size,
      contractSessions: this.contractSessions.size,
      verifiers: this.verifiers.size,
      pendingQueueLoad: this.queue.load,
      disposed: this.disposed,
    }
  }
}

function toNewCriterion(criterion: TaskContract['criteria'][number]): NewCriterionInput {
  return {
    description: criterion.description,
    kind: criterion.specification.kind,
    specification: criterion.specification,
    required: criterion.required,
    severity: criterion.severity,
    freshness: criterion.freshness,
  }
}

export type { ContractId, ExportId, VerificationRunId, SessionFactLog }
