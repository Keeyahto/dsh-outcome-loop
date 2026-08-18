/**
 * beta.4: enterprise policy enforcement, calibration report, cost summary.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OutcomeLoopService } from '../../src/service.ts'
import { outcomeDomainSpec } from '../../src/persistence/schema.ts'
import { Config, type ConfigType } from '../../src/config.ts'
import { calibrationRows, calibrationSummary } from '../../src/dsh/calibration.ts'
import { enforceEnterprisePolicy } from '../../src/domain/aggregate.ts'
import { buildContract } from '../../src/domain/aggregate.ts'
import type { Evidence, TaskContract } from '../../src/domain/types.ts'

let ctx: Context
let root: string
let service: OutcomeLoopService

async function setup(mode: 'personal' | 'enterprise' = 'personal'): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'ol-b4-'))
  ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(outcomeDomainSpec)
  const base = Config({}) as ConfigType
  service = new OutcomeLoopService(ctx, {
    config: mode === 'enterprise'
      ? { ...base, mode, enterprise: { requireCriteria: true, minCriteria: 1, mustIncludeKinds: [], allowedVerifierIds: [] } }
      : base,
    domain,
    ctx,
    version: '0.1.0-beta.4',
    dshVersion: '0.1.0-rc.7',
    trustedEnv: {},
  })
}

beforeEach(async () => { await setup() })

afterEach(async () => {
  try { ctx.stop?.() } catch { /* already stopped */ }
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(root, { recursive: true, force: true })
})

describe('enterprise policy (spec §5.2, §11)', () => {
  it('personal mode is never constrained', async () => {
    const created = await service.createContract({ sessionId: 's', goalText: 'g' })
    expect(created.ok).toBe(true)
  })

  it('enterprise mode enforces minimum criteria at creation', async () => {
    await setup('enterprise')
    const blocked = await service.createContract({ sessionId: 's', goalText: 'g' })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe('policy-denied')
    const allowed = await service.createContract({
      sessionId: 's',
      goalText: 'g',
      criteria: [{ description: 'ok', kind: 'manual', specification: { kind: 'manual', prompt: 'ok' } }],
    })
    expect(allowed.ok).toBe(true)
  })

  it('enterprise mode enforces must-include kinds and verifier allowlist', async () => {
    await setup('enterprise')
    const created = await service.createContract({
      sessionId: 's',
      goalText: 'g',
      criteria: [{ description: 'ok', kind: 'manual', specification: { kind: 'manual', prompt: 'ok' } }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contract = created.value
    // Direct pure-function checks for the other two constraints.
    const withForbiddenVerifier = { ...contract, verificationPolicy: { ...contract.verificationPolicy, allowedVerifierIds: ['evil-verifier'] } }
    const forbidden = enforceEnterprisePolicy(withForbiddenVerifier, {
      active: true, requireCriteria: false, minCriteria: 1, mustIncludeKinds: [], allowedVerifierIds: ['command-exit'],
    })
    expect(forbidden.ok).toBe(false)
    const missingKind = enforceEnterprisePolicy(contract, {
      active: true, requireCriteria: false, minCriteria: 1, mustIncludeKinds: ['command-exit'], allowedVerifierIds: [],
    })
    expect(missingKind.ok).toBe(false)
    expect(enforceEnterprisePolicy(contract, { active: false, requireCriteria: true, minCriteria: 99, mustIncludeKinds: ['x'], allowedVerifierIds: [] }).ok).toBe(true)
  })

  it('revise cannot bypass enterprise requirements', async () => {
    await setup('enterprise')
    const created = await service.createContract({
      sessionId: 's',
      goalText: 'g',
      criteria: [{ description: 'ok', kind: 'manual', specification: { kind: 'manual', prompt: 'ok' } }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const removed = await service.reviseContract({ contractId: created.value.id, expectedRevision: 1 }, { criteria: [] })
    expect(removed.ok).toBe(false)
    if (!removed.ok) expect(removed.error.code).toBe('policy-denied')
  })
})

describe('calibration (§15)', () => {
  const contract: TaskContract = (() => {
    const built = buildContract({
      sessionId: 's',
      goalText: 'g',
      criteria: [{ description: 'c', kind: 'command-exit', specification: { kind: 'command-exit', command: 'x', expectExitCode: 0 } }],
    })
    if (!built.ok) throw new Error('build failed')
    return built.value
  })()

  const decisionEvidence = (over: Partial<Evidence> = {}): Evidence => ({
    schemaVersion: 1,
    id: 'ole-d' as never,
    contractId: contract.id,
    source: 'import',
    observedAt: 1,
    workspaceState: { epoch: 0 },
    fact: { kind: 'decision', source: 'dsh-code-reference', decisionId: 'd1', strategy: 'reuse', predictedMatch: 0.9 },
    strength: 'medium',
    sensitivity: 'internal',
    ...over,
  })

  const run = {
    schemaVersion: 1 as const,
    id: 'olr-1' as never,
    contractId: contract.id,
    contractRevision: 1,
    startedAt: 1,
    finishedAt: 2,
    results: [{ criterionId: 'olcr-1' as never, status: 'pass' as const, evidenceIds: [], staleEvidenceIds: [], conflict: false }],
    status: 'passed' as const,
    labelStrength: 'strong' as const,
    reasons: [],
    source: 'passive' as const,
  }

  it('correlates predictions with actual results', () => {
    const rows = calibrationRows(contract, [decisionEvidence()], run, undefined, { usageKind: 'exact', inputTokens: 100, outputTokens: 50, totalTokens: 150, calls: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.observation).toBe('predicted-and-passed')
    expect(rows[0]?.actual.criteriaPassed).toBe(1)
    expect(rows[0]?.actual.tokens).toBe(150)
  })

  it('flags predicted-but-failed and unknown cases', () => {
    const failed = { ...run, status: 'failed' as const, results: [{ criterionId: 'olcr-1' as never, status: 'fail' as const, evidenceIds: [], staleEvidenceIds: [], conflict: false }] }
    const rows = calibrationRows(contract, [decisionEvidence()], failed, undefined, { usageKind: 'unknown', calls: 0 })
    expect(rows[0]?.observation).toBe('predicted-but-not-passed')
    const noRun = calibrationRows(contract, [decisionEvidence()], undefined, undefined, { usageKind: 'unknown', calls: 0 })
    expect(noRun[0]?.observation).toBe('unknown')
  })

  it('summarizes observations and confirmed reuse', () => {
    const rows = calibrationRows(contract, [decisionEvidence(), decisionEvidence({ id: 'ole-d2' as never, fact: { kind: 'decision', source: 'dsh-code-reference', decisionId: 'd2', strategy: 'rewrite', predictedMatch: 0.2 } })], run, undefined, { usageKind: 'unknown', calls: 0 })
    const summary = calibrationSummary(rows)
    expect(summary.total).toBe(2)
    expect(summary.confirmedReuse).toBe(1)
    expect(summary.predictedMatch.average).toBeCloseTo(0.55)
    expect(summary.observations['predicted-and-passed']).toBe(1)
  })
})
