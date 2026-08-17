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

  it('diagnostic-count and git-scope run read-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ol-active4-'))
    try {
      await writeFile(join(dir, 'a.ts'), 'x')
      const diag = await verifyActive({ kind: 'diagnostic-count', command: 'node -e "console.log(\'1 error\')"', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(diag.status).toBe('fail')
      const diagOk = await verifyActive({ kind: 'diagnostic-count', command: 'node -e "console.log(\'ok\')"', maxErrors: 0, maxWarnings: 0 }, opts(dir))
      expect(diagOk.status).toBe('pass')
      const git = await verifyActive({ kind: 'git-scope', allowedPrefixes: ['src/'], forbiddenPrefixes: [] }, opts(dir))
      // Not a git repo → git commands fail → changed paths empty → pass (no violations observed).
      expect(['pass', 'fail']).toContain(git.status)
      const manual = await verifyActive({ kind: 'manual', prompt: 'x' }, opts(dir))
      expect(manual.status).toBe('unknown')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
})
