/**
 * Prior-decision calibration (§15): correlate decision evidence submitted by
 * dsh-code-reference (or any integration) with the ACTUAL task results.
 *
 * Purely descriptive, local-only, deterministic. Heuristics here are
 * calibration data for the user's own judgment — they never drive routing,
 * never grant permissions, and are never exported as success causation.
 */

import type { Evidence, LabelStrength, TaskContract, TaskDisposition, UserDispositionStatus, VerificationRun } from '../domain/types.ts'
import type { UsageAggregate } from './token-bridge.ts'

export interface CalibrationRow {
  decisionId: string
  source: string
  strategy: string
  candidateRef?: string
  predictedMatch?: number
  predictedEffort?: { files: number; lines: string }
  actual: {
    verificationStatus: VerificationRun['status']
    criteriaPassed: number
    criteriaTotal: number
    tokens: number
    labelStrength: LabelStrength
    disposition: UserDispositionStatus
  }
  /** Descriptive heuristic, never a verdict. */
  observation: 'predicted-and-passed' | 'predicted-but-not-passed' | 'not-predicted-but-passed' | 'not-predicted-and-not-passed' | 'unknown'
}

export interface CalibrationSummary {
  total: number
  predictedMatch: { average?: number; min?: number; max?: number }
  observations: Partial<Record<CalibrationRow['observation'], number>>
  /** Contracts that passed with a reuse/adapt prediction at/above 0.5. */
  confirmedReuse: number
}

const PREDICTION_THRESHOLD = 0.5

export function calibrationRows(
  contract: TaskContract,
  evidenceRows: readonly Evidence[],
  run: VerificationRun | undefined,
  disposition: TaskDisposition | undefined,
  usage: UsageAggregate,
): CalibrationRow[] {
  const rows: CalibrationRow[] = []
  for (const row of evidenceRows) {
    if (row.fact.kind !== 'decision') continue
    const decision = row.fact
    const status = run?.status ?? 'not-run'
    const passed = status === 'passed'
    const predicted = decision.predictedMatch !== undefined && decision.predictedMatch >= PREDICTION_THRESHOLD
    const observation: CalibrationRow['observation'] =
      status === 'not-run' ? 'unknown'
        : predicted && passed ? 'predicted-and-passed'
          : predicted && !passed ? 'predicted-but-not-passed'
            : !predicted && passed ? 'not-predicted-but-passed'
              : 'not-predicted-and-not-passed'
    rows.push({
      decisionId: decision.decisionId,
      source: decision.source,
      strategy: decision.strategy,
      ...(decision.candidateRef === undefined ? {} : { candidateRef: decision.candidateRef }),
      ...(decision.predictedMatch === undefined ? {} : { predictedMatch: decision.predictedMatch }),
      ...(decision.predictedEffort === undefined ? {} : { predictedEffort: decision.predictedEffort }),
      actual: {
        verificationStatus: status,
        criteriaPassed: run?.results.filter((r) => r.status === 'pass').length ?? 0,
        criteriaTotal: run?.results.length ?? contract.criteria.length,
        tokens: usage.totalTokens ?? 0,
        labelStrength: run?.labelStrength ?? 'unknown',
        disposition: disposition?.status ?? 'none',
      },
      observation,
    })
  }
  return rows
}

export function calibrationSummary(rows: readonly CalibrationRow[]): CalibrationSummary {
  const matches = rows.filter((r) => r.predictedMatch !== undefined).map((r) => r.predictedMatch as number)
  const observations: CalibrationSummary['observations'] = {}
  let confirmedReuse = 0
  for (const row of rows) {
    observations[row.observation] = (observations[row.observation] ?? 0) + 1
    if (row.strategy === 'reuse' && row.observation === 'predicted-and-passed') confirmedReuse += 1
  }
  return {
    total: rows.length,
    predictedMatch: matches.length === 0
      ? {}
      : {
          average: matches.reduce((a, b) => a + b, 0) / matches.length,
          min: Math.min(...matches),
          max: Math.max(...matches),
        },
    observations,
    confirmedReuse,
  }
}
