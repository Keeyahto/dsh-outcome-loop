/**
 * Storage domain schema (spec §8.4): `outcome_loop` domain v1.
 *
 * Tables:
 * - contracts         — current snapshot + CAS revision of each Task Contract
 * - evidence          — immutable evidence rows (deterministic ids)
 * - verification_runs — immutable aggregate results
 * - dispositions      — user task-level disposition, CAS revision
 * - session_cursors   — per-session event consumption watermark
 * - exports           — export manifests (never a second copy of content)
 *
 * The domain is the sidecar: outcome data never enters the session log and
 * never touches telemetry. Records validate against these zod schemas at open
 * (`invalid-record` fails loud — no silent field dropping).
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import type { ContractId, EvidenceId, ExportId, SessionIdRef, VerificationRunId } from '../domain/ids.ts'
import type {
  AcceptanceCriterion,
  Constraint,
  CriterionSpecification,
  DataEligibility,
  Evidence,
  EvidenceFreshnessPolicy,
  EvidenceSource,
  ExportManifest,
  Goal,
  JsonValue,
  LabelStrength,
  SensitivityClass,
  TaskContract,
  TaskDisposition,
  TaskScope,
  UserDispositionStatus,
  VerificationRun,
  VerificationStatus,
} from '../domain/types.ts'

// ═══ Shared value schemas ═══

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
)

const goalSchema: z.ZodType<Goal> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reference'),
    ref: z.object({ sessionId: z.string(), seq: z.number().int().nonnegative() }),
  }),
  z.object({ kind: z.literal('explicit'), text: z.string() }),
])

const scopeSchema: z.ZodType<TaskScope> = z.object({
  workspaceRoot: z.string(),
  pathPrefixes: z.array(z.string()),
  allowActiveVerification: z.boolean(),
})

const constraintSchema: z.ZodType<Constraint> = z.object({
  id: z.string(),
  description: z.string(),
})

const specificationSchema: z.ZodType<CriterionSpecification> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command-exit'), command: z.string(), expectExitCode: z.number().int() }),
  z.object({
    kind: z.literal('test-report'),
    framework: z.enum(['tap', 'junit', 'any']),
    minPassed: z.number().int().nonnegative(),
    maxFailed: z.number().int().nonnegative(),
    command: z.string().optional(),
    reportPath: z.string().optional(),
  }),
  z.object({ kind: z.literal('file-exists'), path: z.string() }),
  z.object({ kind: z.literal('file-absent'), path: z.string() }),
  z.object({ kind: z.literal('file-digest'), path: z.string(), algorithm: z.literal('sha256'), digest: z.string() }),
  z.object({ kind: z.literal('json-schema'), path: z.string(), schema: jsonValue }),
  z.object({
    kind: z.literal('git-scope'),
    allowedPrefixes: z.array(z.string()),
    forbiddenPrefixes: z.array(z.string()),
  }),
  z.object({ kind: z.literal('diagnostic-count'), command: z.string(), maxErrors: z.number().int().nonnegative(), maxWarnings: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('manual'), prompt: z.string() }),
  z.object({ kind: z.literal('custom'), providerId: z.string(), params: jsonValue }),
])

const freshnessSchema: z.ZodType<EvidenceFreshnessPolicy> = z.object({
  maxAgeMs: z.number().int().positive().optional(),
  invalidateOnWorkspaceChange: z.boolean(),
})

const criterionObject = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(['command-exit', 'test-report', 'file-exists', 'file-absent', 'file-digest', 'json-schema', 'git-scope', 'diagnostic-count', 'manual', 'custom']),
  required: z.boolean(),
  severity: z.enum(['blocking', 'warning']),
  specification: specificationSchema,
  freshness: freshnessSchema,
})
const criterionSchema = criterionObject as unknown as z.ZodType<AcceptanceCriterion>

const verificationPolicySchema = z.object({
  autoRun: z.boolean(),
  commandTimeoutMs: z.number().int().positive(),
  maxCommandOutputBytes: z.number().int().positive(),
  allowedVerifierIds: z.array(z.string()),
})

const privacyPolicySchema = z.object({
  dataEligibility: z.enum(['private-only', 'exportable', 'contribution-approved'] satisfies readonly [DataEligibility, ...DataEligibility[]]),
  exportAllowed: z.boolean(),
  contentIncluded: z.boolean(),
})

// ═══ Table row schemas ═══

const contractRowObject = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  revision: z.number().int().positive(),
  sessionId: z.string(),
  goal: goalSchema,
  externalKey: z.string().optional(),
  scope: scopeSchema,
  constraints: z.array(constraintSchema),
  criteria: z.array(criterionSchema),
  verificationPolicy: verificationPolicySchema,
  privacyPolicy: privacyPolicySchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export const contractRowSchema = contractRowObject as unknown as z.ZodType<TaskContract>

const workspaceStateSchema = z.object({
  epoch: z.number().int().nonnegative(),
  gitHeadDigest: z.string().optional(),
  changedPathsDigest: z.string().optional(),
})

const evidenceFactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    argvDigest: z.string(),
    commandLabel: z.string(),
    exitCode: z.number().int(),
    cwd: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    errorCode: z.string().optional(),
  }),
  z.object({
    kind: z.literal('test-report'),
    framework: z.string(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative().optional(),
    sourceLabel: z.string(),
  }),
  z.object({
    kind: z.literal('file-state'),
    path: z.string(),
    exists: z.boolean(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mtimeMs: z.number().int().nonnegative().optional(),
    digest: z.string().optional(),
  }),
  z.object({
    kind: z.literal('git-scope'),
    headDigest: z.string().optional(),
    changedPaths: z.array(z.string()),
    violations: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('diagnostic-count'),
    toolLabel: z.string(),
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('turn'),
    turn: z.number().int().nonnegative(),
    reasonKind: z.string(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('usage'),
    provider: z.string().optional(),
    model: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    usageKind: z.enum(['exact', 'estimate', 'unknown']),
  }),
  z.object({
    kind: z.literal('user-confirmation'),
    disposition: z.enum(['accepted', 'rejected', 'revised', 'abandoned', 'none'] satisfies readonly [UserDispositionStatus, ...UserDispositionStatus[]]),
    noteRef: z.object({ sessionId: z.string(), seq: z.number().int().nonnegative() }).optional(),
  }),
  z.object({
    kind: z.literal('feedback'),
    textDigest: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('tool-outcome'),
    toolName: z.string(),
    callId: z.string(),
    isError: z.boolean(),
    errorCode: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: 'verifier',
    providerId: z.string(),
    verdict: z.enum(['pass', 'fail', 'unknown']),
    detail: z.string(),
  }),
  z.object({
    kind: 'decision',
    source: z.string(),
    decisionId: z.string(),
    strategy: z.enum(['reuse', 'adapt', 'dependency', 'rewrite']),
    candidateRef: z.string().optional(),
    predictedMatch: z.number().min(0).max(1).optional(),
    predictedEffort: z.object({ files: z.number().int().nonnegative(), lines: z.string() }).optional(),
    policyDigest: z.string().optional(),
  }),
])

const evidenceRowObject = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  contractId: z.string(),
  criterionId: z.string().optional(),
  source: z.enum(['session-event', 'user', 'verifier', 'feedback', 'token-meter', 'import'] satisfies readonly [EvidenceSource, ...EvidenceSource[]]),
  sourceRef: z.object({ sessionId: z.string(), seq: z.number().int().nonnegative() }).optional(),
  observedAt: z.number().int().nonnegative(),
  workspaceState: workspaceStateSchema,
  fact: evidenceFactSchema,
  strength: z.enum(['strong', 'medium', 'weak'] satisfies readonly [LabelStrength, ...LabelStrength[]]),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'secret', 'personal-data', 'unknown-sensitive'] satisfies readonly [SensitivityClass, ...SensitivityClass[]]),
  digest: z.string().optional(),
  contractRevision: z.number().int().positive(),
  verifierVersion: z.string(),
})
export const evidenceRowSchema = evidenceRowObject as unknown as z.ZodType<Evidence & { contractRevision: number; verifierVersion: string }>

const runRowObject = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  contractId: z.string(),
  contractRevision: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  results: z.array(
    z.object({
      criterionId: z.string(),
      status: z.enum(['pass', 'fail', 'unknown', 'not-applicable']),
      evidenceIds: z.array(z.string()),
      staleEvidenceIds: z.array(z.string()),
      conflict: z.boolean(),
      note: z.string().optional(),
    }),
  ),
  status: z.enum(['not-run', 'passed', 'failed', 'inconclusive'] satisfies readonly [VerificationStatus, ...VerificationStatus[]]),
  labelStrength: z.enum(['strong', 'medium', 'weak', 'unknown'] satisfies readonly [LabelStrength, ...LabelStrength[]]),
  reasons: z.array(z.string()),
  source: z.enum(['passive', 'manual', 'active']),
})
export const runRowSchema = runRowObject as unknown as z.ZodType<VerificationRun>

const dispositionRowObject = z.object({
  contractId: z.string(),
  status: z.enum(['none', 'accepted', 'rejected', 'revised', 'abandoned'] satisfies readonly [UserDispositionStatus, ...UserDispositionStatus[]]),
  revision: z.number().int().positive(),
  noteRef: z.object({ sessionId: z.string(), seq: z.number().int().nonnegative() }).optional(),
  updatedAt: z.number().int().nonnegative(),
})
export const dispositionRowSchema = dispositionRowObject as unknown as z.ZodType<TaskDisposition>

export const cursorRowSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type CursorRow = z.infer<typeof cursorRowSchema>

const sensitivityRecordSchema = z.record(
  z.enum(['public', 'internal', 'confidential', 'secret', 'personal-data', 'unknown-sensitive']),
  z.number().int().nonnegative(),
)

const exportManifestRowObject = z.object({
  id: z.string(),
  contractId: z.string(),
  createdAt: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  contentDigest: z.string(),
  fieldManifest: z.array(z.string()),
  sensitivityHits: sensitivityRecordSchema,
  redactionChanges: z.number().int().nonnegative(),
  license: z.enum(['private-only', 'exportable', 'contribution-approved'] satisfies readonly [DataEligibility, ...DataEligibility[]]),
  schemaVersion: z.literal('outcome-loop.export.v1'),
  outcomeLoopVersion: z.string(),
  dshVersion: z.string().optional(),
})
export const exportManifestRowSchema = exportManifestRowObject as unknown as z.ZodType<ExportManifest>

// ═══ Domain spec ═══

export const outcomeDomainSpec = defineDomain({
  name: 'outcome_loop',
  version: 1,
  tables: {
    contracts: domainTable<ContractId, TaskContract>(contractRowSchema),
    evidence: domainTable<EvidenceId, Evidence & { contractRevision: number; verifierVersion: string }>(evidenceRowSchema),
    verification_runs: domainTable<VerificationRunId, VerificationRun>(runRowSchema),
    dispositions: domainTable<ContractId, TaskDisposition>(dispositionRowSchema),
    session_cursors: domainTable<SessionIdRef, CursorRow>(cursorRowSchema),
    exports: domainTable<ExportId, ExportManifest>(exportManifestRowSchema),
  },
})

export type OutcomeDomain = ReturnType<typeof defineDomain<typeof outcomeDomainSpec>>
