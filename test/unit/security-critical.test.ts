/**
 * Security-critical coverage (spec §19.1): reducer branches, redaction
 * patterns, active verifier paths, repair, and engine conflict/stale paths.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { aggregateVerification, resultReason } from '../../src/domain/reducer.ts'
import { classifyText, redactText } from '../../src/export/redact.ts'
import { verifyActive, type ActiveOptions } from '../../src/verification/adapters/active.ts'
import { repairIndexes } from '../../src/persistence/repair.ts'
import type { Repository } from '../../src/persistence/repository.ts'
import { buildContract } from '../../src/domain/aggregate.ts'
import type { TaskContract } from '../../src/domain/types.ts'

const opts = (cwd: string): ActiveOptions => ({
  cwd,
  scopeRoot: cwd,
  timeoutMs: 5000,
  maxOutputBytes: 65536,
  env: { PATH: process.env.PATH ?? '' },
})

function contract(): TaskContract {
  const built = buildContract({ sessionId: 's', goalText: 'g' })
  if (!built.ok) throw new Error('build failed')
  return built.value
}

describe('reducer branches', () => {
  const crit = { id: 'olcr-1' as never, description: 'c', kind: 'command-exit' as const, required: true, severity: 'blocking' as const, specification: { kind: 'command-exit' as const, command: 'x', expectExitCode: 0 }, freshness: { invalidateOnWorkspaceChange: false } }

  it('warning-only failure keeps passed', () => {
    const warning = { ...crit, id: 'olcr-w' as never, required: false, severity: 'warning' as const }
    const aggregate = aggregateVerification([
      { criterionId: crit.id, status: 'pass', evidenceIds: [], staleEvidenceIds: [], conflict: false },
      { criterionId: warning.id, status: 'fail', evidenceIds: [], staleEvidenceIds: [], conflict: false },
    ], [crit, warning])
    expect(aggregate.status).toBe('passed')
  })

  it('resultReason covers not-applicable and stale', () => {
    expect(resultReason({ criterionId: crit.id, status: 'not-applicable', evidenceIds: [], staleEvidenceIds: [], conflict: false }, crit)).toContain('not applicable')
    expect(resultReason({ criterionId: crit.id, status: 'unknown', evidenceIds: [], staleEvidenceIds: ['e'], conflict: false }, crit)).toContain('stale')
    expect(resultReason({ criterionId: crit.id, status: 'unknown', evidenceIds: [], staleEvidenceIds: [], conflict: true }, crit)).toContain('conflicting')
  })

  it('aggregate label strength stays mechanical (strength comes from evidence rows)', () => {
    const manual = { ...crit, id: 'olcr-m' as never, kind: 'manual' as const, specification: { kind: 'manual' as const, prompt: 'ok?' } }
    const aggregate = aggregateVerification([
      { criterionId: manual.id, status: 'pass', evidenceIds: ['e'], staleEvidenceIds: [], conflict: false, note: 'user accepted' },
    ], [manual])
    expect(aggregate.status).toBe('passed')
    // The reducer only sees results; evidence-grounded strength is computed
    // by the engine from the persisted rows (evidenceLabelStrength).
    expect(aggregate.labelStrength).toBe('strong')
  })
})

describe('redaction patterns', () => {
  it('handles PEM blocks and API tokens', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    expect(redactText(pem, { redactSecrets: true, redactPersonalData: true }).text).toContain('[REDACTED PRIVATE KEY]')
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz123456', { redactSecrets: true, redactPersonalData: true }).text).toContain('[REDACTED TOKEN]')
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', { redactSecrets: true, redactPersonalData: true }).text).toContain('[REDACTED]')
  })

  it('classifyText reports secret hits', () => {
    const result = classifyText('password=hunter2')
    expect(result.sensitivity).toBe('secret')
    expect(result.hits.secret).toBeGreaterThan(0)
  })
})

describe('active verifier paths', () => {
  it('file-exists pass/fail/escape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active-'))
    try {
      const exists = await verifyActive({ kind: 'file-exists', path: 'a.txt' }, opts(dir))
      expect(exists.status).toBe('fail')
      await writeFile(join(dir, 'a.txt'), 'x')
      const exists2 = await verifyActive({ kind: 'file-exists', path: 'a.txt' }, opts(dir))
      expect(exists2.status).toBe('pass')
      const escape = await verifyActive({ kind: 'file-exists', path: '../outside' }, opts(dir))
      expect(escape.status).toBe('unknown')
      const absent = await verifyActive({ kind: 'file-absent', path: 'a.txt' }, opts(dir))
      expect(absent.status).toBe('fail')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('file-digest pass/fail and json-schema valid/invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active2-'))
    try {
      await writeFile(join(dir, 'data.json'), JSON.stringify({ a: 1 }))
      const { createHash } = await import('node:crypto')
      const digest = createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex')
      const okDigest = await verifyActive({ kind: 'file-digest', path: 'data.json', algorithm: 'sha256', digest }, opts(dir))
      expect(okDigest.status).toBe('pass')
      const badDigest = await verifyActive({ kind: 'file-digest', path: 'data.json', algorithm: 'sha256', digest: '0'.repeat(64) }, opts(dir))
      expect(badDigest.status).toBe('fail')
      const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }
      const valid = await verifyActive({ kind: 'json-schema', path: 'data.json', schema }, opts(dir))
      expect(valid.status).toBe('pass')
      const invalid = await verifyActive({ kind: 'json-schema', path: 'data.json', schema: { type: 'string' } }, opts(dir))
      expect(invalid.status).toBe('fail')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('command-exit timeout and unknown start failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active3-'))
    try {
      const slow = await verifyActive({ kind: 'command-exit', command: 'node -e "setInterval(()=>{},1000)"', expectExitCode: 0 }, { ...opts(dir), timeoutMs: 50 })
      expect(slow.status).toBe('unknown')
      const bad = await verifyActive({ kind: 'command-exit', command: '/nonexistent-binary-xyz', expectExitCode: 0 }, opts(dir))
      expect(bad.status).toBe('unknown')
      const ok = await verifyActive({ kind: 'command-exit', command: 'node -e "process.exit(3)"', expectExitCode: 3 }, opts(dir))
      expect(ok.status).toBe('pass')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('diagnostic-count gates on infrastructure failures before parsing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active4-'))
    try {
      await writeFile(join(dir, 'a.ts'), 'x')
      const diag = await verifyActive({ kind: 'diagnostic-count', command: 'node -e "console.log(\'1 error\')"', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(diag.status).toBe('fail')
      const diagOk = await verifyActive({ kind: 'diagnostic-count', command: 'node -e "console.log(\'ok\')"', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(diagOk.status).toBe('pass')
      // Nonexistent command: 0 parsed diagnostics must be unknown, never pass.
      const missing = await verifyActive({ kind: 'diagnostic-count', command: '/nonexistent-diagnostic-binary-xyz', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(missing.status).toBe('unknown')
      expect(missing.note).toContain('failed to start')
      // Timed-out command: partial output must never be counted.
      const slow = await verifyActive(
        { kind: 'diagnostic-count', command: 'node -e "setInterval(()=>console.log(\'1 error\'),200)"', maxErrors: 0, maxWarnings: 0 },
        { ...opts(dir), timeoutMs: 50 },
      )
      expect(slow.status).toBe('unknown')
      // Truncated output: counts are unreliable → unknown.
      const truncated = await verifyActive(
        { kind: 'diagnostic-count', command: 'node -e "console.log(\'x\'.repeat(10000))"', maxErrors: 0, maxWarnings: 0 },
        { ...opts(dir), maxOutputBytes: 32 },
      )
      expect(truncated.status).toBe('unknown')
      expect(truncated.note).toContain('truncated')
      // Non-zero exit with zero parsed diagnostics (tool crashed) → unknown.
      const crashed = await verifyActive({ kind: 'diagnostic-count', command: 'node -e "process.exit(2)"', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(crashed.status).toBe('unknown')
      // Non-zero exit WITH diagnostics (tsc/eslint semantics) stays a fail.
      const findings = await verifyActive({ kind: 'diagnostic-count', command: 'node -e "console.error(\'error TS2322\'); process.exit(1)"', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(findings.status).toBe('fail')
      expect(findings.fact).toMatchObject({ kind: 'diagnostic-count', errors: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('git-scope never trusts failed git output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active5-'))
    try {
      // Not a git repository: both git commands exit non-zero. The error
      // text must not be parsed as changed paths, and the verdict must be
      // unknown — not a pass.
      const notGit = await verifyActive({ kind: 'git-scope', allowedPrefixes: ['src/'], forbiddenPrefixes: [] }, opts(dir))
      expect(notGit.status).toBe('unknown')
      expect(notGit.note).toContain('cannot be trusted')
      // Real repository: changed paths drive the verdict.
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
      await exec('git', ['config', 'user.email', 't@t'], { cwd: dir })
      await exec('git', ['config', 'user.name', 't'], { cwd: dir })
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'src', 'a.ts'), 'x')
      await exec('git', ['add', '-A'], { cwd: dir })
      await exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
      const clean = await verifyActive({ kind: 'git-scope', allowedPrefixes: ['src/'], forbiddenPrefixes: [] }, opts(dir))
      expect(clean.status).toBe('pass')
      await writeFile(join(dir, 'outside.txt'), 'x')
      const violation = await verifyActive({ kind: 'git-scope', allowedPrefixes: ['src/'], forbiddenPrefixes: [] }, opts(dir))
      expect(violation.status).toBe('fail')
      await rm(join(dir, 'outside.txt'))
      await writeFile(join(dir, 'src', 'b.ts'), 'y')
      const allowed = await verifyActive({ kind: 'git-scope', allowedPrefixes: ['src/'], forbiddenPrefixes: ['node_modules/'] }, opts(dir))
      expect(allowed.status).toBe('pass')
      const manual = await verifyActive({ kind: 'manual', prompt: 'x' }, opts(dir))
      expect(manual.status).toBe('unknown')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('symlinked targets outside the workspace are rejected (unknown, never pass)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active6-'))
    const outside = await mkdtemp(join(tmpdir(), 'ol-active6-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside-content')
      const { symlink, readlink } = await import('node:fs/promises')
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
      const { createHash } = await import('node:crypto')
      const outsideDigest = createHash('sha256').update('outside-content').digest('hex')

      const exists = await verifyActive({ kind: 'file-exists', path: 'link.txt' }, opts(dir))
      expect(exists.status).toBe('unknown')
      const digest = await verifyActive({ kind: 'file-digest', path: 'link.txt', algorithm: 'sha256', digest: outsideDigest }, opts(dir))
      expect(digest.status).toBe('unknown')
      expect(digest.note).toContain('escapes')
      const schema = await verifyActive({ kind: 'json-schema', path: 'link.txt', schema: { type: 'string' } }, opts(dir))
      expect(schema.status).toBe('unknown')
      const junit = await verifyActive({ kind: 'test-report', framework: 'junit', minPassed: 1, maxFailed: 0, reportPath: 'link.txt' }, opts(dir))
      expect(junit.status).toBe('unknown')

      // Symlink chain: link2 -> link -> outside/secret.txt must also be rejected.
      await symlink('link.txt', join(dir, 'link2.txt'))
      const chain = await verifyActive({ kind: 'file-digest', path: 'link2.txt', algorithm: 'sha256', digest: outsideDigest }, opts(dir))
      expect(chain.status).toBe('unknown')

      // In-workspace symlinks keep working (no over-blocking).
      await writeFile(join(dir, 'real.txt'), 'inside-content')
      await symlink(join(dir, 'real.txt'), join(dir, 'inner.txt'))
      const insideDigest = createHash('sha256').update('inside-content').digest('hex')
      const inner = await verifyActive({ kind: 'file-digest', path: 'inner.txt', algorithm: 'sha256', digest: insideDigest }, opts(dir))
      expect(inner.status).toBe('pass')
      expect(await readlink(join(dir, 'link.txt'))).toBe(join(outside, 'secret.txt'))
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('decision evidence (§15 code-reference bridge)', () => {
  it('classifyFact treats decisions as internal', async () => {
    const { classifyFact } = await import('../../src/export/redact.ts')
    expect(classifyFact({ kind: 'decision', source: 'dsh-code-reference', decisionId: 'd1', strategy: 'reuse' })).toBe('internal')
  })

  it('impliesVerdict ignores decisions (lineage, not causation)', async () => {
    const { impliesVerdict } = await import('../../src/verification/engine.ts')
    expect(impliesVerdict({ kind: 'decision', source: 'dsh-code-reference', decisionId: 'd1', strategy: 'reuse' }, { kind: 'custom', providerId: 'x', params: {} })).toBe('unknown')
  })
})

describe('repair (spec §8.4)', () => {
  it('removes orphaned indexes and prunes cursors', async () => {
    const contractA = contract()
    const orphanedRun = { schemaVersion: 1 as const, id: 'olr-orphan' as never, contractId: 'olc-missing' as never, contractRevision: 1, startedAt: 1, results: [], status: 'not-run' as const, labelStrength: 'unknown' as const, reasons: [], source: 'passive' as const }
    const orphanedDisposition = { contractId: 'olc-missing' as never, status: 'accepted' as const, revision: 1, updatedAt: 1 }
    const repo = {
      listContracts: () => [contractA],
      listRunsForAll: () => [orphanedRun],
      deleteRun: async () => undefined,
      listDispositionsForAll: () => [orphanedDisposition],
      deleteDisposition: async () => undefined,
      listCursors: () => [
        { sessionId: contractA.sessionId, lastSeq: 5 },
        { sessionId: 'session-without-contract', lastSeq: 9 },
      ],
      deleteCursor: async () => undefined,
    } as unknown as Repository
    const report = await repairIndexes(repo)
    expect(report.orphanedRuns).toBe(1)
    expect(report.orphanedDispositions).toBe(1)
    expect(report.prunedCursors).toBe(1)
  })

  it('opt-in retention prunes only old evidence and never contracts', async () => {
    const contractA = contract()
    const rows = [
      { id: 'ole-old' as never, contractId: contractA.id, observedAt: 10 },
      { id: 'ole-new' as never, contractId: contractA.id, observedAt: 950 },
    ]
    let deleted = 0
    const repo = {
      listContracts: () => [contractA],
      listRunsForAll: () => [],
      deleteRun: async () => undefined,
      listDispositionsForAll: () => [],
      deleteDisposition: async () => undefined,
      listCursors: () => [],
      deleteCursor: async () => undefined,
      listEvidence: () => rows,
      deleteEvidenceRow: async () => { deleted += 1 },
    } as unknown as Repository
    const report = await repairIndexes(repo, { evidenceMaxAgeMs: 100, now: 1000 })
    expect(report.prunedEvidence).toBe(1)
    expect(deleted).toBe(1)
    // Retention disabled by default: nothing pruned.
    const reportOff = await repairIndexes(repo, { evidenceMaxAgeMs: 0, now: 1000 })
    expect(reportOff.prunedEvidence).toBe(0)
  })
})
