/**
 * Integration tests (spec §19.2): real Cordis Context + real storage backend +
 * the actual OutcomeLoopService. Covers contract lifecycle, evidence,
 * verification, disposition, export approval flow and deletion.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OutcomeLoopService } from '../../src/service.ts'
import { outcomeDomainSpec } from '../../src/persistence/schema.ts'
import { Config, configDigest, type ConfigType } from '../../src/config.ts'

let ctx: Context
let root: string
let facility: DomainFacility
let service: OutcomeLoopService

async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'outcome-loop-it-'))
  ctx = new Context()
  // Storage hub (service class mounts itself on construction).
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(outcomeDomainSpec)
  const config = Config({}) as ConfigType
  service = new OutcomeLoopService(ctx, {
    config,
    domain,
    ctx,
    version: '0.1.0-beta.1',
    dshVersion: '0.1.0-rc.7',
    trustedEnv: {},
  })
}

beforeEach(async () => {
  await setup()
})

afterEach(async () => {
  try {
    ctx?.stop?.()
  } catch {
    // disposal may already be complete
  }
  // Let queued domain writes drain before removing the medium.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(root, { recursive: true, force: true })
})

describe('OutcomeLoopService', () => {
  it('creates a contract with conservative defaults', async () => {
    const result = await service.createContract({ sessionId: 'session-1', goalText: 'fix bug' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verificationPolicy.autoRun).toBe(false)
    expect(result.value.privacyPolicy.dataEligibility).toBe('private-only')
    const listed = await service.listContracts({ sessionId: 'session-1' })
    expect(listed.ok && listed.value.length).toBe(1)
  })

  it('rejects duplicate contracts and revision conflicts', async () => {
    const first = await service.createContract({ sessionId: 's1', goalText: 'g' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const dup = await service.createContract({ sessionId: 's1', goalText: 'g' })
    expect(dup.ok).toBe(false)
    const stale = await service.reviseContract({ contractId: first.value.id, expectedRevision: 99 }, {})
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('contract-revision-conflict')
  })

  it('verifies passive evidence end to end (exit-code evidence)', async () => {
    const created = await service.createContract({
      sessionId: 's2',
      goalText: 'make tests pass',
      criteria: [{
        description: 'tests pass',
        kind: 'test-report',
        specification: { kind: 'test-report', framework: 'any', minPassed: 1, maxFailed: 0 },
      }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contractId = created.value.id

    // No evidence yet → unknown → inconclusive.
    const before = await service.verify({ contractId })
    expect(before.ok).toBe(true)
    if (before.ok) expect(before.value.status).toBe('inconclusive')

    // Ingest a session fact: pnpm test exited 0.
    service.registry.ingestEvents('s2', [{
      type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 },
    }, {
      type: 'tool/call', seq: 2, time: 2000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }), turn: 1, step: 1 },
    }, {
      type: 'tool/result', seq: 3, time: 3000, data: {
        message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] }] },
      },
    }, {
      type: 'turn/end', seq: 4, time: 4000, data: { turn: 1, reason: { kind: 'completed' } },
    }])

    const after = await service.verify({ contractId })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.status).toBe('passed')
    expect(after.value.labelStrength).toBe('strong')
    expect(after.value.results[0]?.evidenceIds.length).toBeGreaterThan(0)
    expect(after.value.results[0]?.status).toBe('pass')

    // Evidence is durable and deterministic (re-verify reuses ids).
    const again = await service.verify({ contractId })
    expect(again.ok && again.value.results[0]?.evidenceIds)
      .toEqual(after.value.results[0]?.evidenceIds)
  })

  it('stale evidence: contract revision + lost facts invalidate old results', async () => {
    const created = await service.createContract({
      sessionId: 's3',
      goalText: 'g',
      criteria: [{
        description: 'cmd ok',
        kind: 'command-exit',
        specification: { kind: 'command-exit', command: 'make', expectExitCode: 0 },
      }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contractId = created.value.id
    service.registry.ingestEvents('s3', [{
      type: 'tool/call', seq: 1, time: 1000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'make' }), turn: 1, step: 1 },
    }, {
      type: 'tool/result', seq: 2, time: 2000, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '[exit code: 0]' }] }] } },
    }])
    const first = await service.verify({ contractId })
    expect(first.ok && first.value.status).toBe('passed')

    // Revise the contract (revision 2) and lose the transient fact log
    // (restart with a cold session): prior evidence is stale, no facts to
    // re-derive from ⇒ unknown ⇒ inconclusive (never a fabricated pass).
    const revised = await service.reviseContract({ contractId, expectedRevision: 1 }, {})
    expect(revised.ok).toBe(true)
    if (!revised.ok) return
    service.registry.forget('s3')
    const second = await service.verify({ contractId })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.value.results[0]?.staleEvidenceIds.length).toBeGreaterThan(0)
      expect(second.value.results[0]?.status).toBe('unknown')
      expect(second.value.status).toBe('inconclusive')
    }
  })

  it('manual criterion + user disposition (two independent axes)', async () => {
    const created = await service.createContract({
      sessionId: 's4',
      goalText: 'g',
      criteria: [{
        description: 'user confirms UX',
        kind: 'manual',
        specification: { kind: 'manual', prompt: 'does the UX look right?' },
      }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contractId = created.value.id

    const before = await service.verify({ contractId })
    expect(before.ok && before.value.status).toBe('inconclusive')

    const accepted = await service.setDisposition({ contractId, status: 'accepted' })
    expect(accepted.ok).toBe(true)

    const after = await service.verify({ contractId })
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.value.results[0]?.status).toBe('pass')
      expect(after.value.status).toBe('passed')
    }

    const outcome = await service.getOutcome(contractId)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value.disposition?.status).toBe('accepted')
      expect(outcome.value.latestRun?.status).toBe('passed')
    }
  })

  it('export requires preview → approval → digest binding', async () => {
    const created = await service.createContract({
      sessionId: 's5',
      goalText: 'a distinctive user goal phrase',
      criteria: [{ description: 'manual ok', kind: 'manual', specification: { kind: 'manual', prompt: 'ok?' } }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contractId = created.value.id
    await service.setDisposition({ contractId, status: 'accepted' })
    await service.verify({ contractId })

    const preview = await service.previewExport({ contractId })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.previewDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.value.recordCount).toBe(1)

    // Wrong digest → rejected.
    const bad = await service.exportJsonl({ contractId, previewDigest: '0'.repeat(64) })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('export-approval-invalid')

    // Correct digest → exported content matches preview.
    const approved = await service.exportJsonl({ contractId, previewDigest: preview.value.previewDigest })
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(approved.value.content).toContain('outcome-loop.export.v1')
    expect(approved.value.content).not.toContain('a distinctive user goal phrase') // explicit goal text is never exported
  })

  it('deletes only sidecar data and confirms the session log is untouched', async () => {
    const created = await service.createContract({ sessionId: 's6', goalText: 'g' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contractId = created.value.id
    await service.verify({ contractId })

    const unconfirmed = await service.deleteOutcome({ contractId, confirmed: false })
    expect(unconfirmed.ok).toBe(false)

    const deleted = await service.deleteOutcome({ contractId, confirmed: true })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.sessionLogUntouched).toBe(true)
    expect(deleted.value.deleted.contracts).toBe(1)
    expect((await service.getContract(contractId)).ok).toBe(false)
  })

  it('rejects mutations after disposal', async () => {
    const created = await service.createContract({ sessionId: 's7', goalText: 'g' })
    expect(created.ok).toBe(true)
    // Test-only: simulate the disposal effect that the plugin fiber triggers.
    ;(service as unknown as { disposed: boolean }).disposed = true
    const after = await service.createContract({ sessionId: 's8', goalText: 'g2' })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.code).toBe('plugin-disposed')
  })

  it('live observation: session/event reaches the registry and advances the cursor', async () => {
    const created = await service.createContract({ sessionId: 's-live', goalText: 'g' })
    expect(created.ok).toBe(true)
    const emit = (ctx as unknown as { emit(name: string, ...args: unknown[]): unknown }).emit.bind(ctx)
    const session = { id: 's-live', events: [] }

    emit('session/event', session, { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } })
    emit('session/event', session, { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } })
    // Duplicate delivery must be deduplicated by seq.
    emit('session/event', session, { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const log = service.registry.getLog('s-live')
    expect(log?.facts).toHaveLength(2)
    expect(service.repository.getCursor('s-live')?.lastSeq).toBe(2)
  })

  it('resume replay: session/created fills history from the authoritative log', async () => {
    const created = await service.createContract({ sessionId: 's-resume', goalText: 'g' })
    expect(created.ok).toBe(true)
    const emit = (ctx as unknown as { emit(name: string, ...args: unknown[]): unknown }).emit.bind(ctx)
    // A resumed session carries its whole stored log as a constructor seed.
    const session = {
      id: 's-resume',
      events: [
        { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
        { type: 'user/message', seq: 2, time: 2000, data: { source: { kind: 'user' } } },
        { type: 'turn/end', seq: 3, time: 3000, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }
    emit('session/created', session)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const log = service.registry.getLog('s-resume')
    expect(log?.seqEnd).toBe(3)
    expect(log?.facts.map((f) => f.kind)).toContain('user-message')
    expect(log?.facts.map((f) => f.kind)).toContain('turn-end')
  })

  it('custom verifier registration works and is policy-gated', async () => {
    const created = await service.createContract({
      sessionId: 's9',
      goalText: 'g',
      criteria: [{
        description: 'custom check',
        kind: 'custom',
        specification: { kind: 'custom', providerId: 'my-check', params: {} },
      }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    service.registerVerifier({
      id: 'my-check',
      kinds: ['custom'],
      observesOnly: true,
      executesCommands: false,
      networkAccess: false,
      producesStrength: 'strong',
      run: async () => ({ fact: { kind: 'verifier', providerId: 'my-check', verdict: 'pass', detail: 'ok' }, strength: 'strong', sensitivity: 'internal' }),
    })
    const run = await service.verify({ contractId: created.value.id })
    // Policy denies active run (autoRun=false) → unknown, not a crash.
    expect(run.ok).toBe(true)
    if (run.ok) expect(run.value.results[0]?.status).toBe('unknown')
  })

  it('persists across a restart (reopen the domain)', async () => {
    const created = await service.createContract({ sessionId: 's10', goalText: 'g' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const contractId = created.value.id

    // Simulate restart: close the first service's domain, then boot a fresh
    // process-equivalent (new Context, new facility over the same root).
    await service.repository.domain.close()
    const ctx2 = new Context()
    new Storage(ctx2)
    ctx2.storage.backend.register('json', new JsonStorageBackend(root))
    const facility2 = new DomainFacility(ctx2, { backend: 'json', routes: {} })
    ctx2.storage.mount('domain', facility2)
    const domain2 = await facility2.open(outcomeDomainSpec)
    const config = Config({}) as ConfigType
    const service2 = new OutcomeLoopService(ctx2, {
      config,
      domain: domain2,
      ctx: ctx2,
      version: '0.1.0-beta.1',
      dshVersion: '0.1.0-rc.7',
      trustedEnv: {},
    })
    const restored = await service2.getContract(contractId)
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.value.revision).toBe(1)
    void configDigest
  })
})

// Keep fs readFile referenced for future cold-replay tests.
void readFile
