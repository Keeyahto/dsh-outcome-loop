/**
 * Portable Task Contract file format (spec §6 must-have #2 "建立或导入一份
 * 结构化 Task Contract"): `outcome-loop.contract.v1`.
 *
 * The file is user-authored and user-pointed-at (explicit `/outcome import
 * <path>`); it is never auto-discovered and never trusted implicitly —
 * parsing validates every field, and imported contracts keep the same
 * conservative policy defaults as command-created ones.
 */

import { z } from 'zod'

import { err, ok, type OutcomeResult } from '../domain/errors.ts'
import type { NewCriterionInput } from '../domain/aggregate.ts'
import type { JsonValue, TaskContract } from '../domain/types.ts'

export const CONTRACT_FILE_VERSION = 'outcome-loop.contract.v1'

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
)

export const contractFileSchema = z.object({
  schema_version: z.literal(CONTRACT_FILE_VERSION),
  /** Optional; when present must equal the importing session id. */
  session_id: z.string().optional(),
  goal: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('explicit'), text: z.string().min(1) }),
      z.object({ kind: z.literal('reference'), session_id: z.string(), seq: z.number().int().nonnegative() }),
    ])
    .optional(),
  workspace_root: z.string().optional(),
  constraints: z
    .array(z.object({ id: z.string(), description: z.string() }))
    .optional(),
  criteria: z
    .array(
      z.object({
        description: z.string().min(1),
        kind: z.enum(['command-exit', 'test-report', 'file-exists', 'file-absent', 'file-digest', 'json-schema', 'git-scope', 'diagnostic-count', 'manual', 'custom']),
        required: z.boolean().optional(),
        severity: z.enum(['blocking', 'warning']).optional(),
        specification: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('command-exit'), command: z.string().min(1), expectExitCode: z.number().int() }),
            z.object({
              kind: z.literal('test-report'),
              framework: z.enum(['tap', 'junit', 'any']),
              minPassed: z.number().int().nonnegative(),
              maxFailed: z.number().int().nonnegative(),
              command: z.string().optional(),
              reportPath: z.string().optional(),
            }),
            z.object({ kind: z.literal('file-exists'), path: z.string().min(1) }),
            z.object({ kind: z.literal('file-absent'), path: z.string().min(1) }),
            z.object({ kind: z.literal('file-digest'), path: z.string().min(1), algorithm: z.literal('sha256'), digest: z.string().min(1) }),
            z.object({ kind: z.literal('json-schema'), path: z.string().min(1), schema: jsonValue }),
            z.object({
              kind: z.literal('git-scope'),
              allowedPrefixes: z.array(z.string()),
              forbiddenPrefixes: z.array(z.string()),
            }),
            z.object({ kind: z.literal('diagnostic-count'), command: z.string().min(1), maxErrors: z.number().int().nonnegative(), maxWarnings: z.number().int().nonnegative() }),
            z.object({ kind: z.literal('manual'), prompt: z.string().min(1) }),
            z.object({ kind: z.literal('custom'), providerId: z.string().min(1), params: jsonValue }),
          ]),
        freshness: z
          .object({
            maxAgeMs: z.number().int().positive().optional(),
            invalidateOnWorkspaceChange: z.boolean(),
          })
          .optional(),
      }),
    )
    .optional(),
})

export type ContractFile = z.infer<typeof contractFileSchema>

export interface ParsedContractInput {
  goalText?: string
  goalSeq?: number
  workspaceRoot?: string
  constraints?: readonly { id: string; description: string }[]
  criteria: readonly NewCriterionInput[]
}

/** Parse and validate a contract file for the given session. */
export function parseContractFile(json: string, currentSessionId: string): OutcomeResult<ParsedContractInput> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return err('invalid-input', 'contract file is not valid JSON')
  }
  const result = contractFileSchema.safeParse(parsed)
  if (!result.success) {
    return err('invalid-input', `contract file failed validation: ${result.error.issues[0]?.message ?? 'unknown error'}`)
  }
  const file = result.data
  if (file.session_id !== undefined && file.session_id !== currentSessionId) {
    return err('invalid-input', `contract file targets session '${file.session_id}' but the importing session is '${currentSessionId}'`)
  }
  const criteria: NewCriterionInput[] = (file.criteria ?? []).map((c) => ({
    description: c.description,
    kind: c.specification.kind,
    specification: c.specification,
    ...(c.required === undefined ? {} : { required: c.required }),
    ...(c.severity === undefined ? {} : { severity: c.severity }),
    ...(c.freshness === undefined ? {} : { freshness: c.freshness }),
  }))
  return ok({
    ...(file.goal === undefined ? {} : file.goal.kind === 'explicit'
      ? { goalText: file.goal.text }
      : { goalSeq: file.goal.seq }),
    ...(file.workspace_root === undefined ? {} : { workspaceRoot: file.workspace_root }),
    ...(file.constraints === undefined ? {} : { constraints: file.constraints }),
    criteria,
  })
}

/** Serialize a contract to the portable file format (deterministic key order). */
export function serializeContract(contract: TaskContract): string {
  const file: ContractFile = {
    schema_version: CONTRACT_FILE_VERSION,
    session_id: contract.sessionId,
    goal: contract.goal.kind === 'explicit'
      ? { kind: 'explicit', text: contract.goal.text }
      : { kind: 'reference', session_id: contract.goal.ref.sessionId, seq: contract.goal.ref.seq },
    ...(contract.scope.workspaceRoot === '' ? {} : { workspace_root: contract.scope.workspaceRoot }),
    constraints: contract.constraints.length > 0 ? [...contract.constraints] : undefined,
    criteria: contract.criteria.map((c) => ({
      description: c.description,
      kind: c.kind,
      ...(c.required ? {} : { required: c.required }),
      ...(c.severity === 'blocking' ? {} : { severity: c.severity }),
      specification: c.specification as never,
      freshness: c.freshness,
    })),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}
