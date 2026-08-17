/**
 * Export & redaction tests (spec §14, §16): deterministic content, secret
 * handling, digest stability, approval binding.
 */

import { describe, expect, it } from 'vitest'

import { redactText, classifyText, classifyFact } from '../../src/export/redact.ts'
import { buildExportRecord, buildExportContent, digestOf, serializeRecord } from '../../src/export/jsonl.ts'
import { parseExportRecord, exportRecordSchema } from '../../src/export/schema.ts'
import type { SessionFactLog, TaskContract, VerificationRun } from '../../src/domain/types.ts'
import { buildContract } from '../../src/domain/aggregate.ts'

function contract(): TaskContract {
  const built = buildContract({
    sessionId: 'session-1',
    goalText: 'implement the feature',
    criteria: [{ description: 'tests pass', kind: 'test-report', specification: { kind: 'test-report', framework: 'any', minPassed: 1, maxFailed: 0 } }],
  })
  if (!built.ok) throw new Error('build failed')
  return built.value
}

const run: VerificationRun = {
  schemaVersion: 1,
  id: 'olr-1' as never,
  contractId: 'olc-1' as never,
  contractRevision: 1,
  startedAt: 1000,
  finishedAt: 1100,
  results: [{
    criterionId: 'olcr-1' as never,
    status: 'pass',
    evidenceIds: ['ole-1'],
    staleEvidenceIds: [],
    conflict: false,
  }],
  status: 'passed',
  labelStrength: 'strong',
  reasons: ['criterion passed'],
  source: 'passive',
}

const log: SessionFactLog = {
  sessionId: 'session-1',
  facts: [],
  seqStart: 1,
  seqEnd: 10,
  workspaceEpoch: 0,
}

const input = {
  contract: contract(),
  run,
  disposition: { contractId: 'olc-1' as never, status: 'accepted' as const, revision: 1, updatedAt: 1200 },
  factLog: log,
  usage: { usageKind: 'exact' as const, inputTokens: 100, outputTokens: 50, totalTokens: 150, calls: 3 },
  routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
  outcomeLoopVersion: '0.1.0-beta.1',
  dshVersion: '0.1.0-rc.7',
  configDigest: 'abc123',
}

describe('redactText', () => {
  it('redacts secrets deterministically', () => {
    const { text, changes } = redactText('token=sk-abc123secret456', { redactSecrets: true, redactPersonalData: true })
    expect(text).toContain('[REDACTED]')
    expect(changes).toBeGreaterThan(0)
    expect(redactText('token=sk-abc123secret456', { redactSecrets: true, redactPersonalData: true }).text)
      .toBe(text)
  })

  it('redacts emails and phone numbers as personal data', () => {
    const { text } = redactText('contact me at john.doe@example.com or 13800138000', { redactSecrets: true, redactPersonalData: true })
    expect(text).not.toContain('john.doe@example.com')
    expect(text).not.toContain('13800138000')
  })

  it('neutralizes absolute home paths', () => {
    const { text } = redactText('file at /Users/alice/code/src.ts', { redactSecrets: true, redactPersonalData: true, homePath: '/Users/alice' })
    expect(text).toBe('file at ~/code/src.ts')
  })

  it('leaves plain text untouched', () => {
    const { text, changes } = redactText('the tests passed', { redactSecrets: true, redactPersonalData: true })
    expect(text).toBe('the tests passed')
    expect(changes).toBe(0)
  })
})

describe('classifyText/classifyFact', () => {
  it('unknown content defaults to sensitive', () => {
    expect(classifyText('api_key=abc').sensitivity).toBe('secret')
    expect(classifyText('a@b.com').sensitivity).toBe('personal-data')
    expect(classifyText('short plain text').sensitivity).toBe('public')
  })

  it('command and file-state facts are confidential', () => {
    expect(classifyFact({ kind: 'command', argvDigest: 'd', commandLabel: 'x', exitCode: 0 })).toBe('confidential')
    expect(classifyFact({ kind: 'file-state', path: 'a', exists: true })).toBe('confidential')
    expect(classifyFact({ kind: 'usage', usageKind: 'exact' })).toBe('public')
  })
})

describe('export records (spec §16)', () => {
  it('builds a schema-valid record with fixed key order', () => {
    const record = buildExportRecord(input)
    const parsed = exportRecordSchema.parse(record)
    expect(parsed.schema_version).toBe('outcome-loop.export.v1')
    expect(parsed.verification.status).toBe('passed')
    expect(parsed.user_disposition.status).toBe('accepted')
    expect(parsed.privacy.content_included).toBe(false)
    expect(parsed.lineage.provider).toBeUndefined() // provider/model never causally used
  })

  it('is deterministic and diffable', () => {
    const a = buildExportContent(input)
    const b = buildExportContent(input)
    expect(a.content).toBe(b.content)
    expect(a.contentDigest).toBe(b.contentDigest)
    expect(a.content.endsWith('\n')).toBe(true)
  })

  it('serializes one parseable JSONL line', () => {
    const line = serializeRecord(buildExportRecord(input))
    expect(line.split('\n').length).toBe(1)
    expect(parseExportRecord(line).record_id).toBe(input.contract.id)
  })

  it('explicit goal text is never exported verbatim', () => {
    const record = buildExportRecord(input)
    expect(JSON.stringify(record)).not.toContain('implement the feature')
    expect(record.task.goal_digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('digestOf is stable sha256', () => {
    expect(digestOf('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('schema rejects unknown required-field semantics', () => {
    const record = buildExportRecord(input) as Record<string, unknown>
    expect(() => exportRecordSchema.parse({ ...record, schema_version: 'outcome-loop.export.v2' })).toThrow()
  })
})
