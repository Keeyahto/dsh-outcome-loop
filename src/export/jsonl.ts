/**
 * Export serialization (spec §14.5, §16): deterministic, diffable JSONL.
 * Key order is fixed by construction; every line is independently parseable;
 * stable sorting makes exports reproducible.
 */

import { createHash } from 'node:crypto'

import type { SessionFactLog, TaskContract, TaskDisposition, VerificationRun } from '../domain/types.ts'
import type { ExportRecord } from './schema.ts'
import { EXPORT_SCHEMA_VERSION, EXPORT_FIELD_MANIFEST, exportRecordSchema } from './schema.ts'
import { REDACTION_VERSION } from './redact.ts'

export interface ExportInput {
  contract: TaskContract
  run: VerificationRun | undefined
  disposition: TaskDisposition | undefined
  factLog: SessionFactLog | undefined
  usage: { usageKind: 'exact' | 'estimate' | 'unknown'; inputTokens?: number; outputTokens?: number; totalTokens?: number; calls: number }
  routes: readonly { provider: string; model: string }[]
  outcomeLoopVersion: string
  dshVersion: string | undefined
  configDigest: string
}

/** Build one export record (fixed key order). */
export function buildExportRecord(input: ExportInput): ExportRecord {
  const { contract } = input
  const record: ExportRecord = {
    schema_version: EXPORT_SCHEMA_VERSION,
    record_id: contract.id,
    task: {
      contract_id: contract.id,
      goal_ref: contract.goal.kind === 'reference'
        ? { session_id: contract.goal.ref.sessionId, seq: contract.goal.ref.seq }
        : null,
      goal_digest: contract.goal.kind === 'explicit' ? digestOf(contract.goal.text) : '',
      criteria: contract.criteria.map((c) => ({
        id: c.id,
        description: c.description,
        kind: c.kind,
        required: c.required,
        severity: c.severity,
      })),
    },
    trajectory: {
      session_id: contract.sessionId,
      seq_start: input.factLog?.seqStart ?? 0,
      seq_end: input.factLog?.seqEnd ?? 0,
      model_routes: input.routes.map((r) => ({ provider: r.provider, model: r.model })),
    },
    verification: {
      status: input.run?.status ?? 'not-run',
      criteria: (input.run?.results ?? []).map((r) => ({
        criterion_id: r.criterionId,
        status: r.status,
        evidence_count: r.evidenceIds.length,
        stale_count: r.staleEvidenceIds.length,
        conflict: r.conflict,
        note: r.note ?? null,
      })),
      label_strength: input.run?.labelStrength ?? 'unknown',
    },
    user_disposition: {
      status: input.disposition?.status ?? 'none',
      revision: input.disposition?.revision ?? 0,
      updated_at: input.disposition?.updatedAt ?? 0,
    },
    cost: {
      usage_kind: input.usage.usageKind,
      input_tokens: input.usage.inputTokens ?? null,
      output_tokens: input.usage.outputTokens ?? null,
      total_tokens: input.usage.totalTokens ?? null,
      calls: input.usage.calls,
    },
    privacy: {
      content_included: false,
      redaction_version: REDACTION_VERSION,
      license: contract.privacyPolicy.dataEligibility,
    },
    lineage: {
      outcome_loop_version: input.outcomeLoopVersion,
      dsh_version: input.dshVersion ?? null,
      config_digest: input.configDigest,
    },
  }
  return exportRecordSchema.parse(record)
}

export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Serialize one record as a single JSONL line (stable key order). */
export function serializeRecord(record: ExportRecord): string {
  return JSON.stringify(record)
}

/** Build the full export content (one line per record) + digest + manifest. */
export function buildExportContent(input: ExportInput): { content: string; recordCount: number; contentDigest: string } {
  const record = buildExportRecord(input)
  const line = serializeRecord(record)
  const content = `${line}\n`
  return {
    content,
    recordCount: 1,
    contentDigest: digestOf(content),
  }
}

/** Field manifest for previews (single source of truth). */
export function fieldManifest(): readonly string[] {
  return [...EXPORT_FIELD_MANIFEST]
}

