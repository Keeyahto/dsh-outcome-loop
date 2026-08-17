/**
 * Startup repair (spec §8.4): derived indexes must be rebuildable from the
 * authoritative records, partial failures must be detectable and fixed on
 * the next load, and nothing may be silently dropped.
 *
 * Repair rules implemented here:
 * 1. verification runs and dispositions referencing a missing contract are
 *    orphaned → removed (their authority, the contract, is gone; keeping them
 *    would fabricate an outcome for nothing).
 * 2. session cursors beyond any known event are harmless (replay dedupes),
 *    but cursors for sessions without contracts are pruned to keep the
 *    sidecar bounded.
 * 3. Any invalid record already fails loud at domain open (storage-domain
 *    `invalid-record`), so no silent field dropping happens before repair.
 */

import type { Repository } from './repository.ts'

export interface RepairReport {
  orphanedRuns: number
  orphanedDispositions: number
  prunedCursors: number
}

export async function repairIndexes(repo: Repository): Promise<RepairReport> {
  const report: RepairReport = { orphanedRuns: 0, orphanedDispositions: 0, prunedCursors: 0 }

  const contracts = new Set(repo.listContracts().map((c) => c.id))

  // Orphaned runs and dispositions.
  for (const run of repo.listRunsForAll()) {
    if (!contracts.has(run.contractId)) {
      await repo.deleteRun(run.id)
      report.orphanedRuns += 1
    }
  }
  for (const disposition of repo.listDispositionsForAll()) {
    if (!contracts.has(disposition.contractId)) {
      await repo.deleteDisposition(disposition.contractId)
      report.orphanedDispositions += 1
    }
  }

  // Prune cursors that do not belong to any contract session.
  const contractSessions = new Set(repo.listContracts().map((c) => c.sessionId))
  for (const cursor of repo.listCursors()) {
    if (!contractSessions.has(cursor.sessionId)) {
      await repo.deleteCursor(cursor.sessionId)
      report.prunedCursors += 1
    }
  }

  return report
}
