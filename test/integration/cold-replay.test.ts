/**
 * Cold-session replay (spec §8.3 rule 5): with the optional
 * session-persistence service mounted, verification of a contract on a cold
 * session replays the authoritative log and derives passive evidence.
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

let ctx: Context
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-cold-'))
  ctx = new Context()
})

afterEach(async () => {
  try { ctx.stop?.() } catch { /* already stopped */ }
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(root, { recursive: true, force: true })
})

async function buildService(withPersistence: boolean): Promise<OutcomeLoopService> {
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(outcomeDomainSpec)
  if (withPersistence) {
    ctx.provide('sessionPersistence', {
      inspect: async (id: string) => ({
        meta: { id, version: 1, createdAt: 1 },
        events: [
          { type: 'tool/call', seq: 1, time: 1000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'make test' }), turn: 1, step: 1 } },
          { type: 'tool/result', seq: 2, time: 2000, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] }] } } },
        ],
      }),
    } as never)
  }
  return new OutcomeLoopService(ctx, {
    config: Config({}) as ConfigType,
    domain,
    ctx,
    version: '0.1.0-beta.1',
    dshVersion: '0.1.0-rc.7',
    trustedEnv: {},
  })
}

describe('cold replay', () => {
  it('verification replays a cold session through sessionPersistence', async () => {
    const service = await buildService(true)
    const created = await service.createContract({
      sessionId: 's-cold',
      goalText: 'cold session task',
      criteria: [{
        description: 'make test exits 0',
        kind: 'command-exit',
        specification: { kind: 'command-exit', command: 'make test', expectExitCode: 0 },
      }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const run = await service.verify({ contractId: created.value.id })
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.value.status).toBe('passed')
    expect(run.value.results[0]?.status).toBe('pass')
  })

  it('without sessionPersistence a cold session stays conservatively unknown', async () => {
    const service = await buildService(false)
    const created = await service.createContract({
      sessionId: 's-cold2',
      goalText: 'no persistence',
      criteria: [{
        description: 'make test exits 0',
        kind: 'command-exit',
        specification: { kind: 'command-exit', command: 'make test', expectExitCode: 0 },
      }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const run = await service.verify({ contractId: created.value.id })
    expect(run.ok).toBe(true)
    if (run.ok) {
      expect(run.value.status).toBe('inconclusive')
      expect(run.value.results[0]?.status).toBe('unknown')
    }
  })
})
