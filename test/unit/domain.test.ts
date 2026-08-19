/**
 * Pure domain unit tests: ids, contracts, aggregation rules (§7.4), freshness,
 * failure taxonomy. No DSH, no filesystem.
 */

import { describe, expect, it } from 'vitest'

import { buildContract, reviseContract, criterionById, executionStatusOf, appendFact, validateScope, workspaceEpochOf } from '../../src/domain/aggregate.ts'
import { aggregateVerification, resultReason } from '../../src/domain/reducer.ts'
import { evidenceFreshness } from '../../src/domain/freshness.ts'
import { contentHash, deriveContractId, deriveEvidenceId } from '../../src/domain/ids.ts'
import { err, ok, isOutcomeError } from '../../src/domain/errors.ts'
import type { AcceptanceCriterion, Evidence, TaskContract, TaskScope } from '../../src/domain/types.ts'

function contractWith(specification: AcceptanceCriterion['specification'], over: Partial<AcceptanceCriterion> = {}): { contract: TaskContract; criterion: AcceptanceCriterion } {
  const built = buildContract({
    sessionId: 'session-1',
    goalText: 'fix the bug',
    criteria: [{
      description: over.description ?? 'criterion',
      kind: specification.kind,
      specification,
      required: over.required ?? true,
      severity: over.severity ?? 'blocking',
    }],
  })
  expect(built.ok).toBe(true)
  const contract = (built as { ok: true; value: TaskContract }).value
  return { contract, criterion: contract.criteria[0]! }
}


describe('ids', () => {
  it('derives deterministic ids', () => {
    expect(deriveContractId('s', 3, 100)).toBe(deriveContractId('s', 3, 100))
    expect(deriveContractId('s', 3, 100)).not.toBe(deriveContractId('s', 4, 100))
    expect(deriveEvidenceId('olc-x' as never, 'olcr-1' as never, 'fact')).toBe(deriveEvidenceId('olc-x' as never, 'olcr-1' as never, 'fact'))
    expect(contentHash('a', 1)).toBe(contentHash('a', 1))
    expect(contentHash('a', 1)).not.toBe(contentHash('a', 2))
  })
})

describe('buildContract', () => {
  it('requires a goal', () => {
    const result = buildContract({ sessionId: 's' })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('invalid-input')
  })

  it('defaults to conservative policies', () => {
    const built = buildContract({ sessionId: 's', goalText: 'g' })
    expect(built.ok).toBe(true)
    const contract = (built as { ok: true; value: TaskContract }).value
    expect(contract.revision).toBe(1)
    expect(contract.verificationPolicy.autoRun).toBe(false)
    expect(contract.privacyPolicy.dataEligibility).toBe('private-only')
    expect(contract.scope.allowActiveVerification).toBe(false)
    expect(contract.criteria).toEqual([])
  })

  it('rejects non-absolute workspace roots', () => {
    const result = buildContract({ sessionId: 's', goalText: 'g', workspaceRoot: 'relative/path' })
    expect(result.ok).toBe(false)
  })

  it('assigns stable criterion ids by position', () => {
    const built = buildContract({ sessionId: 's', goalText: 'g', criteria: [{
      description: 'c1', kind: 'manual', specification: { kind: 'manual', prompt: 'c1' },
    }, {
      description: 'c2', kind: 'manual', specification: { kind: 'manual', prompt: 'c2' },
    }] })
    expect(built.ok).toBe(true)
    const contract = (built as { ok: true; value: TaskContract }).value
    expect(contract.criteria[0]?.id).not.toBe(contract.criteria[1]?.id)
  })
})

describe('validateScope — platform-aware workspaceRoot (DEP-01)', () => {
  // Acceptance cases from the Forge vNext plan §DEP-01, exercised via
  // Node's platform-aware `path.isAbsolute`. Test inputs are derived from
  // `process.platform` so the same suite passes on POSIX and on Windows.
  const isWin = process.platform === 'win32'

  // Paths that are absolute on the current platform only.
  const absoluteOnCurrent = isWin
    ? ['C:\\repo', 'C:/repo', 'D:\\path\\to\\repo', String.raw`C:\Users\Admin`]
    : ['/root/repo', '/tmp/ws', '/Users/x']

  // Paths that are relative on every platform (must reject).
  const relativeAlways = ['relative/path', './x', 'foo/bar', '']

  // Forward-slash paths: on POSIX they are absolute, on Windows Node's
  // `path.isAbsolute('/foo')` also returns true (Win API treats leading
  // slash as absolute). Documenting this with an explicit test prevents
  // future regressions if someone re-tightens the validator.
  const leadingSlashAbsoluteEverywhere = ['/leading/slash/path']

  function scope(workspaceRoot: string): TaskScope {
    return { workspaceRoot, pathPrefixes: [], allowActiveVerification: false }
  }

  it.each(absoluteOnCurrent)('accepts absolute path on current platform: %s', (path) => {
    const result = validateScope(scope(path));
    expect(result.ok).toBe(true);
  })

  it.each(relativeAlways)('rejects relative path: %s', (path) => {
    // The empty string is handled separately below as the documented
    // sentinel; here we only test paths that look like relative paths.
    if (path === '') return;
    const result = validateScope(scope(path));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-input');
    }
  })

  it.each(leadingSlashAbsoluteEverywhere)('treats leading-slash path as absolute everywhere: %s', (path) => {
    // Node's `path.isAbsolute('/foo')` returns true on both POSIX and Windows,
    // so this is a deliberate "always accepted" case. It exists so a future
    // tightening of `validateScope` cannot regress this without being noticed.
    const result = validateScope(scope(path));
    expect(result.ok).toBe(true);
  })

  it('accepts the empty-string sentinel (no workspace root)', () => {
    // Consistent with `verification/policy.ts:64` — empty string is the
    // "no workspace root" sentinel and is accepted as before.
    const result = validateScope(scope(''));
    expect(result.ok).toBe(true);
  })

  it('rejects an empty-looking whitespace string', () => {
    // Whitespace is not the documented sentinel; must reject.
    const result = validateScope(scope('   '));
    expect(result.ok).toBe(false);
  })

  it('end-to-end: buildContract with a Windows-style absolute path on Windows, POSIX-style on POSIX', () => {
    // Smoke test through the public `buildContract` factory path so a
    // regression in `validateScope` is caught at the entry point as well.
    const wsRoot = isWin ? String.raw`C:\Users\Admin\proj` : '/home/user/proj'
    const built = buildContract({ sessionId: 's', goalText: 'g', workspaceRoot: wsRoot })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.value.scope.workspaceRoot).toBe(wsRoot)
    }
  })
})

describe('reviseContract', () => {
  it('bumps the revision and keeps identity', () => {
    const { contract } = contractWith({ kind: 'manual', prompt: 'x' })
    const revised = reviseContract(contract, {})
    expect(revised.ok).toBe(true)
    const next = (revised as { ok: true; value: TaskContract }).value
    expect(next.revision).toBe(contract.revision + 1)
    expect(next.id).toBe(contract.id)
  })
})

describe('aggregateVerification (spec §7.4)', () => {
  const spec = { kind: 'command-exit' as const, command: 'pnpm test', expectExitCode: 0 }

  it('not-run when nothing executed', () => {
    const { criterion } = contractWith(spec)
    const aggregate = aggregateVerification([], [criterion])
    expect(aggregate.status).toBe('not-run')
    expect(aggregate.labelStrength).toBe('unknown')
  })

  it('failed when any required blocking criterion fails (rule 1)', () => {
    const { criterion } = contractWith(spec)
    const aggregate = aggregateVerification([
      { criterionId: criterion.id, status: 'fail', evidenceIds: [], staleEvidenceIds: [], conflict: false, note: 'exit 1' },
    ], [criterion])
    expect(aggregate.status).toBe('failed')
  })

  it('inconclusive when a required criterion is unknown (rule 2)', () => {
    const { criterion } = contractWith(spec)
    const aggregate = aggregateVerification([
      { criterionId: criterion.id, status: 'unknown', evidenceIds: [], staleEvidenceIds: [], conflict: false, note: 'no evidence' },
    ], [criterion])
    expect(aggregate.status).toBe('inconclusive')
  })

  it('passed when all required pass (rule 3)', () => {
    const { criterion } = contractWith(spec)
    const aggregate = aggregateVerification([
      { criterionId: criterion.id, status: 'pass', evidenceIds: ['e'], staleEvidenceIds: [], conflict: false },
    ], [criterion])
    expect(aggregate.status).toBe('passed')
  })

  it('warnings never flip passed/failed (rule 5)', () => {
    const { contract, criterion } = contractWith(spec)
    const { contract: contract2, criterion: warning } = contractWith({ kind: 'manual', prompt: 'w' }, { required: false, severity: 'warning' })
    void contract2
    const aggregate = aggregateVerification([
      { criterionId: criterion.id, status: 'pass', evidenceIds: [], staleEvidenceIds: [], conflict: false },
      { criterionId: warning.id, status: 'fail', evidenceIds: [], staleEvidenceIds: [], conflict: false },
    ], [criterion, warning])
    expect(aggregate.status).toBe('passed')
    expect(aggregate.reasons.some((r) => r.includes('warning'))).toBe(true)
    void contract
  })

  it('conflicting evidence → inconclusive (rule 6)', () => {
    const { criterion } = contractWith(spec)
    const aggregate = aggregateVerification([
      { criterionId: criterion.id, status: 'unknown', evidenceIds: ['a', 'b'], staleEvidenceIds: [], conflict: true },
    ], [criterion])
    expect(aggregate.status).toBe('inconclusive')
    expect(aggregate.labelStrength).toBe('unknown')
  })

  it('stale evidence does not count toward pass (rule 7)', () => {
    const { criterion } = contractWith(spec)
    const aggregate = aggregateVerification([
      { criterionId: criterion.id, status: 'unknown', evidenceIds: [], staleEvidenceIds: ['e-old'], conflict: false },
    ], [criterion])
    expect(aggregate.status).toBe('inconclusive')
  })

  it('label strength: strong only with no judge and no conflicts', () => {
    const { criterion } = contractWith(spec)
    expect(aggregateVerification([
      { criterionId: criterion.id, status: 'pass', evidenceIds: ['e'], staleEvidenceIds: [], conflict: false },
    ], [criterion]).labelStrength).toBe('strong')
    expect(aggregateVerification([
      { criterionId: criterion.id, status: 'pass', evidenceIds: ['e'], staleEvidenceIds: [], conflict: false, note: 'judge: weak' },
    ], [criterion]).labelStrength).toBe('weak')
  })
})

describe('evidenceFreshness (spec §12.4)', () => {
  const evidence = (over: Partial<Evidence> = {}): Evidence => ({
    schemaVersion: 1,
    id: 'ole-1' as never,
    contractId: 'olc-1' as never,
    source: 'session-event',
    observedAt: 1000,
    workspaceState: { epoch: 0 },
    fact: { kind: 'turn', turn: 1, reasonKind: 'completed' },
    strength: 'strong',
    sensitivity: 'public',
    ...over,
  })

  const ctx = (over: Partial<Parameters<typeof evidenceFreshness>[2]> = {}): Parameters<typeof evidenceFreshness>[2] => ({
    capturedContractRevision: 1,
    currentContractRevision: 1,
    currentWorkspaceEpoch: 0,
    verifierVersion: 'v1',
    capturedVerifierVersion: 'v1',
    now: 2000,
    ...over,
  })

  it('contract revision change → stale', () => {
    expect(evidenceFreshness(evidence(), { invalidateOnWorkspaceChange: false }, ctx({ currentContractRevision: 2 }))).toBe('stale')
  })

  it('workspace epoch change → stale when invalidateOnWorkspaceChange', () => {
    expect(evidenceFreshness(evidence(), { invalidateOnWorkspaceChange: true }, ctx({ currentWorkspaceEpoch: 1 }))).toBe('stale')
  })

  it('unknown current epoch → unknown (conservative)', () => {
    expect(evidenceFreshness(evidence(), { invalidateOnWorkspaceChange: true }, ctx({ currentWorkspaceEpoch: undefined }))).toBe('unknown')
  })

  it('max age exceeded → stale', () => {
    expect(evidenceFreshness(evidence(), { invalidateOnWorkspaceChange: false, maxAgeMs: 500 }, ctx({ now: 2000 }))).toBe('stale')
  })

  it('fresh when nothing changed', () => {
    expect(evidenceFreshness(evidence(), { invalidateOnWorkspaceChange: true }, ctx())).toBe('fresh')
  })
})

describe('failure taxonomy', () => {
  it('result envelope works', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 })
    const failure = err('evidence-missing', 'nothing observed')
    expect(failure.ok).toBe(false)
    expect(isOutcomeError((failure as { error: unknown }).error)).toBe(true)
  })

  it('infrastructure errors never carry business codes', () => {
    const failure = err('storage-error', 'disk full')
    expect(failure.ok).toBe(false)
    expect((failure as { error: { code: string } }).error.code).toBe('storage-error')
  })
})

describe('execution status', () => {
  it('maps turn end reasons to the execution axis', () => {
    let log = { sessionId: 's', facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 }
    log = appendFact(log, { kind: 'turn-end', seq: 1, time: 1, turn: 1, reasonKind: 'completed' })
    expect(executionStatusOf(log)).toBe('ended')
    log = appendFact(log, { kind: 'turn-end', seq: 2, time: 2, turn: 2, reasonKind: 'aborted' })
    expect(executionStatusOf(log)).toBe('aborted')
    expect(workspaceEpochOf(log)).toBe(0)
  })
})

describe('resultReason', () => {
  it('produces actionable notes', () => {
    const { contract, criterion } = contractWith({ kind: 'command-exit', command: 'x', expectExitCode: 0 })
    const reason = resultReason({ criterionId: criterion.id, status: 'fail', evidenceIds: [], staleEvidenceIds: [], conflict: false, note: 'exit code 1 ≠ 0' }, criterion)
    expect(reason).toContain('criterion failed')
    expect(reason).toContain('exit code 1 ≠ 0')
    expect(criterionById(contract, criterion.id)).toBeDefined()
  })
})
