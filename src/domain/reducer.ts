/**
 * Verification aggregation rules (spec §7.4) — pure functions.
 *
 * The outcome of a task is never a single boolean. These rules combine
 * per-criterion results into an aggregate status while keeping the
 * mechanical verdict, user disposition, and label strength independent.
 */

import type { AcceptanceCriterion, LabelStrength, VerificationResult, VerificationStatus } from './types.ts'

export interface AggregateOutcome {
  status: VerificationStatus
  labelStrength: LabelStrength
  reasons: readonly string[]
}

const REASON_PREFIX = 'outcome-loop'

/** Human-readable next action for one criterion result. */
export function resultReason(result: VerificationResult, criterion: AcceptanceCriterion | undefined): string {
  const label = criterion?.description ?? result.criterionId
  switch (result.status) {
    case 'pass':
      return `${REASON_PREFIX}: criterion passed: ${label}`
    case 'fail':
      return `${REASON_PREFIX}: criterion failed: ${label}${result.note ? ` — ${result.note}` : ''}`
    case 'not-applicable':
      return `${REASON_PREFIX}: criterion not applicable: ${label}`
    case 'unknown':
      if (result.staleEvidenceIds.length > 0) {
        return `${REASON_PREFIX}: criterion unknown (stale evidence): ${label} — re-verify after the workspace changed`
      }
      if (result.conflict) {
        return `${REASON_PREFIX}: criterion unknown (conflicting evidence): ${label}`
      }
      return `${REASON_PREFIX}: criterion unknown (evidence missing): ${label}${result.note ? ` — ${result.note}` : ''}`
  }
}

/**
 * Aggregate per spec §7.4 rules 1–9.
 *
 * 1. any required+blocking `fail`        → `failed`
 * 2. no fails but ≥1 required `unknown`  → `inconclusive`
 * 3. all required pass/not-applicable    → `passed`
 * 4. no verification executed            → `not-run`
 * 5. warning criteria never flip passed/failed, but are surfaced in results
 * 6. conflicting current evidence        → `inconclusive` (never pick the favorable one)
 * 7. stale evidence is excluded from the pass computation
 * 8. user acceptance does not change the mechanical status
 * 9. a judge label is at most `weak`
 */
export function aggregateVerification(
  results: readonly VerificationResult[],
  criteria: readonly AcceptanceCriterion[],
): AggregateOutcome {
  const reasons: string[] = []

  if (results.length === 0) {
    return {
      status: 'not-run',
      labelStrength: 'unknown',
      reasons: [`${REASON_PREFIX}: no verification has been executed for this contract`],
    }
  }

  const byId = new Map(criteria.map((c) => [c.id, c]))
  const requiredBlocking = results.filter((r) => {
    const c = byId.get(r.criterionId)
    return c !== undefined && c.required && c.severity === 'blocking'
  })
  const warnings = results.filter((r) => {
    const c = byId.get(r.criterionId)
    return c !== undefined && c.severity === 'warning'
  })

  // Rule 1: any required+blocking fail → failed.
  const failed = requiredBlocking.filter((r) => r.status === 'fail')
  if (failed.length > 0) {
    for (const r of failed) reasons.push(resultReason(r, byId.get(r.criterionId)))
    return { status: 'failed', labelStrength: 'strong', reasons }
  }

  // Rule 6: conflicting current evidence → inconclusive by default.
  const conflicted = requiredBlocking.filter((r) => r.conflict)
  if (conflicted.length > 0) {
    for (const r of conflicted) {
      reasons.push(`${REASON_PREFIX}: conflicting evidence for criterion ${r.criterionId} — mechanical status inconclusive`)
    }
    return { status: 'inconclusive', labelStrength: 'unknown', reasons }
  }

  // Rule 2: any required unknown → inconclusive.
  const unknown = requiredBlocking.filter((r) => r.status === 'unknown')
  if (unknown.length > 0) {
    for (const r of unknown) reasons.push(resultReason(r, byId.get(r.criterionId)))
    return { status: 'inconclusive', labelStrength: labelStrengthFor(results, byId), reasons }
  }

  // Rules 3+5: all required pass/not-applicable → passed (warnings shown).
  const allPass = requiredBlocking.every((r) => r.status === 'pass' || r.status === 'not-applicable')
  if (allPass) {
    for (const r of results) reasons.push(resultReason(r, byId.get(r.criterionId)))
    for (const w of warnings) {
      reasons.push(`${REASON_PREFIX}: warning criterion ${w.criterionId}: ${w.status}${w.note ? ` — ${w.note}` : ''}`)
    }
    return { status: 'passed', labelStrength: labelStrengthFor(results, byId), reasons }
  }

  return { status: 'inconclusive', labelStrength: 'unknown', reasons }
}

/**
 * Label strength for a passing aggregate:
 * - `strong`  — every result backed by strong evidence, no conflict, no judge;
 * - `medium`  — at least one medium/weak-but-user signal;
 * - `weak`    — only judge-derived labels;
 * - `unknown` — nothing else applies.
 */
function labelStrengthFor(
  results: readonly VerificationResult[],
  byId: ReadonlyMap<string, AcceptanceCriterion>,
): LabelStrength {
  const considered = results.filter((r) => {
    const c = byId.get(r.criterionId)
    return c !== undefined && c.required
  })
  if (considered.length === 0) return 'unknown'
  const anyJudge = considered.some((r) => r.note?.includes('judge') ?? false)
  const allStrong = considered.every((r) => r.status === 'pass' || r.status === 'not-applicable')
  if (allStrong && !anyJudge) return 'strong'
  if (anyJudge && !allStrong) return 'weak'
  if (anyJudge) return 'weak'
  return 'medium'
}
