/**
 * Export preview (spec §14.5): the mandatory first phase of the two-phase
 * export. A preview computes candidate records, the field manifest,
 * sensitivity hits, redaction changes and a content digest; the approval
 * binds to that digest, and `exportJsonl` re-computes it before writing —
 * any change since preview invalidates the approval.
 */

import type { SessionFactLog, SensitivityClass, TaskContract, TaskDisposition, VerificationRun } from '../domain/types.ts'
import type { Repository } from '../persistence/repository.ts'
import { buildExportContent, type ExportInput } from './jsonl.ts'
import { classifyFact } from './redact.ts'
import { EXPORT_SCHEMA_VERSION, EXPORT_FIELD_MANIFEST } from './schema.ts'

export interface PreviewOptions {
  outcomeLoopVersion: string
  dshVersion: string | undefined
  configDigest: string
}

export interface PreviewResult {
  content: string
  contentDigest: string
  recordCount: number
  fieldManifest: readonly string[]
  sensitivityHits: Readonly<Record<SensitivityClass, number>>
  redactionChanges: number
  warnings: readonly string[]
}

const EMPTY_HITS: Readonly<Record<SensitivityClass, number>> = Object.freeze({
  public: 0,
  internal: 0,
  confidential: 0,
  secret: 0,
  'personal-data': 0,
  'unknown-sensitive': 0,
})

/** Compute the export preview for one contract. Never writes anything. */
export function buildExportPreview(
  contract: TaskContract,
  run: VerificationRun | undefined,
  disposition: TaskDisposition | undefined,
  factLog: SessionFactLog | undefined,
  repository: Repository,
  options: PreviewOptions,
  usage: ExportInput['usage'],
  routes: ExportInput['routes'],
): PreviewResult {
  const warnings: string[] = []
  const sensitivityHits: Record<SensitivityClass, number> = { ...EMPTY_HITS }

  // Sensitivity scan over the contract's evidence rows (counts only).
  for (const row of repository.listEvidence(contract.id)) {
    const sensitivity = classifyFact(row.fact)
    sensitivityHits[sensitivity] += 1
  }
  if (sensitivityHits.secret > 0) {
    warnings.push(`secret-class evidence present (${sensitivityHits.secret} rows) — only counts are exported, never content`)
  }
  if (sensitivityHits['personal-data'] > 0) {
    warnings.push(`personal-data evidence present (${sensitivityHits['personal-data']} rows) — content is redacted before export`)
  }

  if (!contract.privacyPolicy.exportAllowed) {
    warnings.push('contract privacy policy forbids export')
  }
  if (contract.privacyPolicy.dataEligibility === 'contribution-approved') {
    warnings.push('contribution-approved eligibility requires an independent consent flow — core export does not provide one')
  }

  const input: ExportInput = {
    contract,
    run,
    disposition,
    factLog,
    usage,
    routes,
    outcomeLoopVersion: options.outcomeLoopVersion,
    dshVersion: options.dshVersion,
    configDigest: options.configDigest,
  }
  const built = buildExportContent(input)
  const record = JSON.parse(built.content) as { schema_version?: string }
  if (record.schema_version !== EXPORT_SCHEMA_VERSION) {
    warnings.push('schema version mismatch in generated export')
  }

  return {
    content: built.content,
    contentDigest: built.contentDigest,
    recordCount: built.recordCount,
    fieldManifest: [...EXPORT_FIELD_MANIFEST],
    sensitivityHits,
    redactionChanges: 0, // Export records carry no raw content by default (§16).
    warnings,
  }
}
