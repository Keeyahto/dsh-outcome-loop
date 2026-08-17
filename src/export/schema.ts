/**
 * Open export format (spec §16): `outcome-loop.export.v1`.
 *
 * One JSONL line per record. Records are derived views — they never mutate
 * the ledger. Provider/model ride as lineage, never as success causation.
 * Only strong/medium, conflict-free records can ever become training
 * candidates; that curation is a future separate tool, not this package.
 */

import { z } from 'zod'

export const EXPORT_SCHEMA_VERSION = 'outcome-loop.export.v1'

export const exportRecordSchema = z.object({
  schema_version: z.literal(EXPORT_SCHEMA_VERSION),
  record_id: z.string(),
  task: z.object({
    contract_id: z.string(),
    goal_ref: z.object({ session_id: z.string(), seq: z.number().int().nonnegative() }).nullable(),
    goal_digest: z.string(),
    criteria: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        kind: z.string(),
        required: z.boolean(),
        severity: z.enum(['blocking', 'warning']),
      }),
    ),
  }),
  trajectory: z.object({
    session_id: z.string(),
    seq_start: z.number().int().nonnegative(),
    seq_end: z.number().int().nonnegative(),
    model_routes: z.array(z.object({ provider: z.string(), model: z.string() })),
  }),
  verification: z.object({
    status: z.enum(['not-run', 'passed', 'failed', 'inconclusive']),
    criteria: z.array(
      z.object({
        criterion_id: z.string(),
        status: z.enum(['pass', 'fail', 'unknown', 'not-applicable']),
        evidence_count: z.number().int().nonnegative(),
        stale_count: z.number().int().nonnegative(),
        conflict: z.boolean(),
        note: z.string().nullable(),
      }),
    ),
    label_strength: z.enum(['strong', 'medium', 'weak', 'unknown']),
  }),
  user_disposition: z.object({
    status: z.enum(['none', 'accepted', 'rejected', 'revised', 'abandoned']),
    revision: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  }),
  cost: z.object({
    usage_kind: z.enum(['exact', 'estimate', 'unknown']),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    total_tokens: z.number().int().nonnegative().nullable(),
    calls: z.number().int().nonnegative(),
  }),
  privacy: z.object({
    content_included: z.literal(false),
    redaction_version: z.string(),
    license: z.enum(['private-only', 'exportable', 'contribution-approved']),
  }),
  lineage: z.object({
    outcome_loop_version: z.string(),
    dsh_version: z.string().nullable(),
    config_digest: z.string(),
  }),
})

export type ExportRecord = z.infer<typeof exportRecordSchema>

/** Stable field manifest — one definition, referenced by previews and docs. */
export const EXPORT_FIELD_MANIFEST = [
  'schema_version',
  'record_id',
  'task.contract_id',
  'task.goal_ref',
  'task.goal_digest',
  'task.criteria',
  'trajectory.session_id',
  'trajectory.seq_start',
  'trajectory.seq_end',
  'trajectory.model_routes',
  'verification.status',
  'verification.criteria',
  'verification.label_strength',
  'user_disposition',
  'cost',
  'privacy',
  'lineage',
] as const

/** Validate a parsed export record; unknown required fields fail loud. */
export function parseExportRecord(line: string): ExportRecord {
  const parsed: unknown = JSON.parse(line)
  return exportRecordSchema.parse(parsed)
}
