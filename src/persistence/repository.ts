/**
 * Repository over the outcome_loop storage domain (spec §8.4).
 *
 * Concurrency notes:
 * - storage-domain serializes every write on one per-domain chain and
 *   `update()` is an atomic read-modify-write at its queue slot, so per-key
 *   CAS needs no extra lock. The caller-facing guarantees are documented:
 *   no cross-process conditional write (single-process assumption, see
 *   SECURITY.md).
 * - The authoritative record is written first; derived indexes (runs,
 *   dispositions) are written after; every derived index is rebuildable from
 *   the contracts/evidence tables (repair.ts).
 * - Returned records are detached, frozen snapshots — callers never mutate
 *   stored objects in place.
 */

import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'

import type { ContractId, EvidenceId, ExportId, SessionIdRef, VerificationRunId } from '../domain/ids.ts'
import type { Evidence, ExportManifest, TaskContract, TaskDisposition, VerificationRun } from '../domain/types.ts'
import { outcomeDomainSpec, type CursorRow } from './schema.ts'

export type EvidenceRow = Evidence & { contractRevision: number; verifierVersion: string }

export interface Repository {
  readonly domain: Domain<typeof outcomeDomainSpec>

  getContract(id: ContractId): TaskContract | undefined
  putContract(contract: TaskContract): Promise<void>
  /** CAS: applies `next` only when the stored revision equals `expected`. */
  updateContract(id: ContractId, next: TaskContract, expectedRevision: number): Promise<boolean>
  deleteContract(id: ContractId): Promise<void>
  listContracts(): TaskContract[]

  getEvidence(id: EvidenceId): EvidenceRow | undefined
  /** Idempotent put (deterministic ids); returns whether the row was new. */
  putEvidence(row: EvidenceRow): Promise<boolean>
  listEvidence(contractId: ContractId): EvidenceRow[]
  deleteEvidenceRow(id: EvidenceId): Promise<void>
  deleteEvidence(contractId: ContractId): Promise<void>

  putRun(run: VerificationRun): Promise<void>
  listRuns(contractId: ContractId): VerificationRun[]
  listRunsForAll(): VerificationRun[]
  deleteRun(id: VerificationRunId): Promise<void>
  deleteRuns(contractId: ContractId): Promise<void>

  getDisposition(contractId: ContractId): TaskDisposition | undefined
  putDisposition(disposition: TaskDisposition): Promise<void>
  /** CAS on disposition revision. */
  updateDisposition(contractId: ContractId, next: TaskDisposition, expectedRevision: number): Promise<boolean>
  deleteDisposition(contractId: ContractId): Promise<void>
  listDispositionsForAll(): TaskDisposition[]

  getCursor(sessionId: SessionIdRef): CursorRow | undefined
  /** Monotonic watermark: only ever moves forward. */
  advanceCursor(sessionId: SessionIdRef, lastSeq: number): Promise<CursorRow>
  listCursors(): readonly { sessionId: SessionIdRef; lastSeq: number }[]
  deleteCursor(sessionId: SessionIdRef): Promise<void>

  putExportManifest(manifest: ExportManifest): Promise<void>
  getExportManifest(id: ExportId): ExportManifest | undefined
  listExportManifests(contractId: ContractId): ExportManifest[]
  deleteExportManifests(contractId: ContractId): Promise<void>
}

export function createRepository(domain: Domain<typeof outcomeDomainSpec>): Repository {
  const contracts = domain.table('contracts')
  const evidence = domain.table('evidence') as unknown as KvTable<EvidenceId, EvidenceRow>
  const runs = domain.table('verification_runs')
  const dispositions = domain.table('dispositions')
  const cursors = domain.table('session_cursors')
  const exportsTable = domain.table('exports')

  const detach = <T>(value: T): T => {
    if (value === undefined) return value
    return Object.freeze(structuredClone(value)) as T
  }

  return {
    domain,

    getContract(id) {
      return detach(contracts.get(id))
    },
    async putContract(contract) {
      await contracts.put(contract.id, contract)
    },
    async updateContract(id, next, expectedRevision) {
      try {
        await contracts.update(id, (current) => {
          if (current.revision !== expectedRevision) {
            throw new ContractRevisionMismatch(expectedRevision, current.revision)
          }
          return next
        })
        return true
      } catch (error) {
        if (error instanceof ContractRevisionMismatch) return false
        throw error
      }
    },
    async deleteContract(id) {
      await contracts.delete(id)
    },
    listContracts() {
      const out: TaskContract[] = []
      for (const [, value] of contracts.entries()) out.push(detach(value))
      return out
    },

    getEvidence(id) {
      return detach(evidence.get(id)) as EvidenceRow | undefined
    },
    async putEvidence(row) {
      const existing = evidence.get(row.id)
      await evidence.put(row.id, row)
      return existing === undefined
    },
    listEvidence(contractId) {
      const out: EvidenceRow[] = []
      for (const [, value] of evidence.entries()) {
        if (value.contractId === contractId) out.push(detach(value) as EvidenceRow)
      }
      return out
    },
    async deleteEvidenceRow(id) {
      await evidence.delete(id)
    },
    async deleteEvidence(contractId) {
      const keys: EvidenceId[] = []
      for (const [key, value] of evidence.entries()) {
        if (value.contractId === contractId) keys.push(key)
      }
      for (const key of keys) await evidence.delete(key)
    },

    async putRun(run) {
      await runs.put(run.id, run)
    },
    listRuns(contractId) {
      const out: VerificationRun[] = []
      for (const [, value] of runs.entries()) {
        if (value.contractId === contractId) out.push(detach(value))
      }
      out.sort((a, b) => a.startedAt - b.startedAt)
      return out
    },
    listRunsForAll() {
      const out: VerificationRun[] = []
      for (const [, value] of runs.entries()) out.push(detach(value))
      return out
    },
    async deleteRun(id) {
      await runs.delete(id)
    },
    async deleteRuns(contractId) {
      const keys: VerificationRunId[] = []
      for (const [key, value] of runs.entries()) {
        if (value.contractId === contractId) keys.push(key)
      }
      for (const key of keys) await runs.delete(key)
    },

    getDisposition(contractId) {
      return detach(dispositions.get(contractId))
    },
    async putDisposition(disposition) {
      await dispositions.put(disposition.contractId, disposition)
    },
    async updateDisposition(contractId, next, expectedRevision) {
      try {
        await dispositions.update(contractId, (current) => {
          if (current.revision !== expectedRevision) {
            throw new ContractRevisionMismatch(expectedRevision, current.revision)
          }
          return next
        })
        return true
      } catch (error) {
        if (error instanceof ContractRevisionMismatch) return false
        throw error
      }
    },
    async deleteDisposition(contractId) {
      await dispositions.delete(contractId)
    },
    listDispositionsForAll() {
      const out: TaskDisposition[] = []
      for (const [, value] of dispositions.entries()) out.push(detach(value))
      return out
    },

    getCursor(sessionId) {
      return detach(cursors.get(sessionId))
    },
    async advanceCursor(sessionId, lastSeq) {
      const existing = cursors.get(sessionId)
      const next: CursorRow = {
        lastSeq: Math.max(existing?.lastSeq ?? -1, lastSeq),
        updatedAt: Date.now(),
      }
      await cursors.put(sessionId, next)
      return detach(next)
    },
    listCursors() {
      const out: { sessionId: SessionIdRef; lastSeq: number }[] = []
      for (const [sessionId, value] of cursors.entries()) {
        out.push({ sessionId, lastSeq: value.lastSeq })
      }
      return out
    },
    async deleteCursor(sessionId) {
      await cursors.delete(sessionId)
    },

    async putExportManifest(manifest) {
      await exportsTable.put(manifest.id, manifest)
    },
    getExportManifest(id) {
      return detach(exportsTable.get(id))
    },
    listExportManifests(contractId) {
      const out: ExportManifest[] = []
      for (const [, value] of exportsTable.entries()) {
        if (value.contractId === contractId) out.push(detach(value))
      }
      return out
    },
    async deleteExportManifests(contractId) {
      const keys: ExportId[] = []
      for (const [key, value] of exportsTable.entries()) {
        if (value.contractId === contractId) keys.push(key)
      }
      for (const key of keys) await exportsTable.delete(key)
    },
  }
}

/** Internal CAS mismatch marker (not an OutcomeError — the repository reports boolean). */
class ContractRevisionMismatch extends Error {
  constructor(
    readonly expected: number,
    readonly current: number,
  ) {
    super(`revision mismatch: expected ${expected}, current ${current}`)
  }
}
