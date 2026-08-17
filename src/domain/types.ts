/**
 * Pure domain types for the outcome ledger.
 *
 * This module is the single source of the stable domain vocabulary. It must
 * stay free of DSH imports, filesystem access, clock reads and network use —
 * everything here is plain JSON-shaped data so it can be validated with zod,
 * persisted in storage domains and exported losslessly.
 */

import type { ContractId, CriterionId, EvidenceId, ExportId, SessionIdRef, VerificationRunId } from './ids.ts'

/** Contract schema version. Bump only with a documented migration strategy. */
export const CONTRACT_SCHEMA_VERSION = 1 as const
export const EVIDENCE_SCHEMA_VERSION = 1 as const
export const RUN_SCHEMA_VERSION = 1 as const
export const EXPORT_SCHEMA_VERSION = 'outcome-loop.export.v1' as const

/** What happened to the agent/process executing the task. */
export type ExecutionStatus = 'active' | 'ended' | 'aborted' | 'blocked'

/** What the acceptance evidence says about one criterion. */
export type CriterionStatus = 'pass' | 'fail' | 'unknown' | 'not-applicable'

/** Aggregated verification status for the whole contract. */
export type VerificationStatus = 'not-run' | 'passed' | 'failed' | 'inconclusive'

/** How the user handled the result. Independent of mechanical verification. */
export type UserDispositionStatus = 'none' | 'accepted' | 'rejected' | 'revised' | 'abandoned'

/** How trustworthy a conclusion is. */
export type LabelStrength = 'strong' | 'medium' | 'weak' | 'unknown'

/** What the data may be used for. */
export type DataEligibility = 'private-only' | 'exportable' | 'contribution-approved'

/** Sensitivity classification used for redaction and export gating. */
export type SensitivityClass =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'secret'
  | 'personal-data'
  | 'unknown-sensitive'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// ═══ Task Contract ═══

/** Reference to the authoritative goal source in the session log (no content copy). */
export interface GoalReference {
  sessionId: SessionIdRef
  /** Seq of the user/message (or turn/start) event carrying the goal. */
  seq: number
}

export type Goal =
  | { kind: 'reference'; ref: GoalReference }
  | { kind: 'explicit'; text: string }

export interface TaskScope {
  /** Absolute workspace root; must be an existing directory when active verification is allowed. */
  workspaceRoot: string
  /** Path prefixes the task may touch (workspace-relative). Empty = whole workspace. */
  pathPrefixes: readonly string[]
  /** Whether the trusted policy allows ACTIVE verification commands. Never true by default. */
  allowActiveVerification: boolean
}

export interface Constraint {
  id: string
  description: string
}

/** First batch of criterion kinds (spec §7.2). Extensible via custom verifiers. */
export type CriterionKind =
  | 'command-exit'
  | 'test-report'
  | 'file-exists'
  | 'file-absent'
  | 'file-digest'
  | 'json-schema'
  | 'git-scope'
  | 'diagnostic-count'
  | 'manual'
  | 'custom'

/**
 * Verifiable, versionable discriminated union. Natural-language strings are
 * never eval'd; each specification is interpreted by a registered verifier.
 */
export type CriterionSpecification =
  | { kind: 'command-exit'; command: string; expectExitCode: number }
  | { kind: 'test-report'; framework: 'tap' | 'junit' | 'any'; minPassed: number; maxFailed: number }
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-absent'; path: string }
  | { kind: 'file-digest'; path: string; algorithm: 'sha256'; digest: string }
  | { kind: 'json-schema'; path: string; schema: JsonValue }
  | { kind: 'git-scope'; allowedPrefixes: readonly string[]; forbiddenPrefixes: readonly string[] }
  | { kind: 'diagnostic-count'; command: string; maxErrors: number; maxWarnings: number }
  | { kind: 'manual'; prompt: string }
  | { kind: 'custom'; providerId: string; params: JsonValue }

export interface EvidenceFreshnessPolicy {
  /** Evidence older than this many milliseconds is stale regardless of workspace state. */
  maxAgeMs?: number
  /** Whether a workspace change after capture invalidates this evidence. */
  invalidateOnWorkspaceChange: boolean
}

export interface AcceptanceCriterion {
  /** Stable id — never positional. */
  id: CriterionId
  description: string
  kind: CriterionKind
  required: boolean
  severity: 'blocking' | 'warning'
  specification: CriterionSpecification
  freshness: EvidenceFreshnessPolicy
}

export interface VerificationPolicy {
  /** Active verification runs only when the deployment explicitly enables this. */
  autoRun: boolean
  commandTimeoutMs: number
  maxCommandOutputBytes: number
  /** Whitelist of verifier provider ids allowed to run (active). Empty = none. */
  allowedVerifierIds: readonly string[]
}

export interface TaskPrivacyPolicy {
  dataEligibility: DataEligibility
  exportAllowed: boolean
  /** Whether export may include user-chosen content excerpts (default: false). */
  contentIncluded: boolean
}

export interface TaskContract {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION
  id: ContractId
  /** Monotonic revision; mutations use compare-and-set on this value. */
  revision: number
  sessionId: SessionIdRef
  goal: Goal
  scope: TaskScope
  constraints: readonly Constraint[]
  criteria: readonly AcceptanceCriterion[]
  verificationPolicy: VerificationPolicy
  privacyPolicy: TaskPrivacyPolicy
  createdAt: number
  updatedAt: number
}

export interface TaskContractSummary {
  id: ContractId
  revision: number
  sessionId: SessionIdRef
  goalKind: Goal['kind']
  goalDigest: string
  criterionCount: number
  updatedAt: number
}

// ═══ Evidence ═══

export type EvidenceSource = 'session-event' | 'user' | 'verifier' | 'feedback' | 'token-meter' | 'import'

export interface WorkspaceStateReference {
  /** Monotonic workspace-change epoch at capture time (0 = no change observed). */
  epoch: number
  gitHeadDigest?: string
  changedPathsDigest?: string
}

export type EvidenceFact =
  | {
      kind: 'command'
      /** Deterministic digest of argv; never the raw argv when sensitive. */
      argvDigest: string
      /** Short human label, e.g. `pnpm test`. */
      commandLabel: string
      exitCode: number
      cwd?: string
      durationMs?: number
      outputBytes?: number
      outputTruncated?: boolean
      errorCode?: string
    }
  | {
      kind: 'test-report'
      framework: string
      passed: number
      failed: number
      skipped?: number
      sourceLabel: string
    }
  | {
      kind: 'file-state'
      path: string
      exists: boolean
      sizeBytes?: number
      mtimeMs?: number
      digest?: string
    }
  | {
      kind: 'git-scope'
      headDigest?: string
      changedPaths: readonly string[]
      violations: readonly string[]
    }
  | {
      kind: 'diagnostic-count'
      toolLabel: string
      errors: number
      warnings: number
    }
  | {
      kind: 'turn'
      turn: number
      reasonKind: string
      durationMs?: number
    }
  | {
      kind: 'usage'
      provider?: string
      model?: string
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      usageKind: 'exact' | 'estimate' | 'unknown'
    }
  | {
      kind: 'user-confirmation'
      disposition: UserDispositionStatus
      noteRef?: { sessionId: SessionIdRef; seq: number }
    }
  | {
      kind: 'feedback'
      textDigest: string
      seq: number
    }
  | {
      kind: 'tool-outcome'
      toolName: string
      callId: string
      isError: boolean
      errorCode?: string
      durationMs?: number
      outputBytes?: number
    }
  | {
      kind: 'verifier'
      providerId: string
      verdict: 'pass' | 'fail' | 'unknown'
      detail: string
    }

export interface Evidence {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
  id: EvidenceId
  contractId: ContractId
  criterionId?: CriterionId
  source: EvidenceSource
  /** Point into the authoritative session log; never a content copy. */
  sourceRef?: { sessionId: SessionIdRef; seq: number }
  observedAt: number
  workspaceState: WorkspaceStateReference
  fact: EvidenceFact
  strength: 'strong' | 'medium' | 'weak'
  sensitivity: SensitivityClass
  digest?: string
}

// ═══ Verification ═══

export interface VerificationResult {
  criterionId: CriterionId
  status: CriterionStatus
  evidenceIds: readonly EvidenceId[]
  staleEvidenceIds: readonly EvidenceId[]
  conflict: boolean
  /** Human-readable gap / next action for this criterion. */
  note?: string
}

export interface VerificationRun {
  schemaVersion: typeof RUN_SCHEMA_VERSION
  id: VerificationRunId
  contractId: ContractId
  contractRevision: number
  startedAt: number
  finishedAt?: number
  results: readonly VerificationResult[]
  status: VerificationStatus
  labelStrength: LabelStrength
  /** Human-readable aggregate gaps and next actions. */
  reasons: readonly string[]
  source: 'passive' | 'manual' | 'active'
}

export interface TaskDisposition {
  contractId: ContractId
  status: UserDispositionStatus
  /** CAS revision. */
  revision: number
  noteRef?: { sessionId: SessionIdRef; seq: number }
  updatedAt: number
}

// ═══ Outcome view ═══

export interface TaskOutcomeView {
  contract: TaskContract
  latestRun?: VerificationRun
  disposition: TaskDisposition | undefined
  executionStatus: ExecutionStatus
  /** Combined mechanical + user axes (spec §7.4 rule 9, §12.5). */
  labelStrength: LabelStrength
}

// ═══ Export ═══

export interface ExportManifest {
  id: ExportId
  contractId: ContractId
  createdAt: number
  recordCount: number
  /** sha256 over the canonical export content; approval binds to this. */
  contentDigest: string
  fieldManifest: readonly string[]
  sensitivityHits: Readonly<Record<SensitivityClass, number>>
  redactionChanges: number
  license: DataEligibility
  schemaVersion: typeof EXPORT_SCHEMA_VERSION
  outcomeLoopVersion: string
  dshVersion: string | undefined
}

export interface ExportPreview {
  manifest: Omit<ExportManifest, 'id' | 'contractId' | 'createdAt' | 'contentDigest'>
  /** Canonical export text (deterministic). */
  content: string
  contentDigest: string
  warnings: readonly string[]
}

// ═══ Session facts (transient derived index, rebuildable from the log) ═══

/**
 * Lightweight normalized observation of one durable session event. This is
 * the ONLY thing the hot path produces: constant-size, no content copied.
 * Facts are a derived index — never the authority; they rebuild from replay.
 */
export type SessionFact =
  | { kind: 'turn-start'; seq: number; time: number; turn: number }
  | { kind: 'turn-end'; seq: number; time: number; turn: number; reasonKind: string }
  | { kind: 'step-start'; seq: number; time: number; turn: number; step: number }
  | { kind: 'step-end'; seq: number; time: number; turn: number; step: number }
  | { kind: 'user-message'; seq: number; time: number; source: string }
  | { kind: 'usage'; seq: number; time: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; usageKind: 'exact' | 'estimate' | 'unknown' }
  | { kind: 'tool-call'; seq: number; time: number; callId: string; name: string; argumentsDigest: string }
  | { kind: 'tool-result'; seq: number; time: number; callId: string; name: string; isError: boolean; errorCode?: string; durationMs?: number; outputBytes?: number; exitCode?: number; commandLabel?: string }
  | { kind: 'file-change-marker'; seq: number; time: number; toolName: string }
  | { kind: 'feedback'; seq: number; time: number; textDigest: string }
  | { kind: 'route'; seq: number; time: number; provider: string; model: string }
  | { kind: 'unknown'; seq: number; time: number; type: string }

/** Per-session accumulator consumed by verification and cost bridges. */
export interface SessionFactLog {
  sessionId: SessionIdRef
  facts: readonly SessionFact[]
  /** First seq observed (inclusive). */
  seqStart: number
  /** Last seq observed (inclusive). */
  seqEnd: number
  /** Workspace-change epoch: increments per file-change marker. */
  workspaceEpoch: number
}
