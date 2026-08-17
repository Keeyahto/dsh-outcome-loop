/**
 * `/outcome` command consumer integration (spec §5.1, §10): the command only
 * talks to ctx.outcomeLoop and performs the user-facing file write for
 * approved exports. Never model-visible.
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
import { Config, type ConfigType } from '../../src/config.ts'
import { apply as applyCommands } from '../../src/consumers/commands.ts'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

let ctx: Context
let root: string
let service: OutcomeLoopService
let registered: CommandDefinition[]

async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'ol-cmd-'))
  ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(outcomeDomainSpec)
  service = new OutcomeLoopService(ctx, {
    config: Config({}) as ConfigType,
    domain,
    ctx,
    version: '0.1.0-beta.1',
    dshVersion: '0.1.0-rc.7',
    trustedEnv: {},
  })
  registered = []
  ctx.provide('commands', { register: (def: CommandDefinition) => { registered.push(def) } } as never)
  applyCommands(ctx)
}

beforeEach(setup)

afterEach(async () => {
  try { ctx.stop?.() } catch { /* already stopped */ }
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(root, { recursive: true, force: true })
})

async function run(rawInput: string, cwd: string) {
  const def = registered.find((d) => d.name === 'outcome')
  expect(def).toBeDefined()
  const result = await def!.handler({
    commandId: 'cmd-1' as never,
    agent: { session: { id: 's-cmd', header: { cwd } } },
    rawInput,
    signal: new AbortController().signal,
  } as never)
  return result
}

describe('/outcome command', () => {
  it('creates a contract and adds criteria', async () => {
    const created = await run('new 修复登录 bug', '/tmp')
    expect(created.kind).toBe('success')
    const text = (created as { text: string }).text
    expect(text).toContain('Contract created')
    const criterion = await run('criterion add 移动端不溢出', '/tmp')
    expect(criterion.kind).toBe('success')
    expect((criterion as { text: string }).text).toContain('Criterion 1 added')
    const list = await run('list', '/tmp')
    expect((list as { text: string }).text).toContain('1 criteria')
  })

  it('rejects criterion commands without a contract', async () => {
    const result = await run('criterion add 没有契约', '/tmp')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('no contract')
  })

  it('verifies and sets disposition', async () => {
    const created = await run('new 让测试通过', '/tmp')
    const id = extractContractId((created as { text: string }).text)
    const criterion = await run(`criterion add-command "make" --expect 0`, '/tmp')
    expect(criterion.kind).toBe('success')
    service.registry.ingestEvents('s-cmd', [{
      type: 'tool/call', seq: 1, time: 1000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'make' }), turn: 1, step: 1 },
    }, {
      type: 'tool/result', seq: 2, time: 2000, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '[exit code: 0]' }] }] } },
    }])
    const verify = await run(`verify ${id}`, '/tmp')
    expect((verify as { text: string }).text).toContain('passed')
    const accepted = await run(`accept ${id}`, '/tmp')
    expect((accepted as { text: string }).text).toContain('disposition = accepted')
    const status = await run(`status ${id}`, '/tmp')
    expect((status as { text: string }).text).toContain('Disposition: accepted')
    expect((status as { text: string }).text).toContain('Verification: passed')
  })

  it('two-phase export: preview digest → approve writes an atomic file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ol-cmd-ws-'))
    try {
      const created = await run('new 导出目标目标', cwd)
      const id = extractContractId((created as { text: string }).text)

      const preview = await run(`export ${id}`, cwd)
      const previewText = (preview as { text: string }).text
      expect(previewText).toContain('digest')
      const digest = /digest ([0-9a-f]{64})/.exec(previewText)?.[1]
      expect(digest).toBeDefined()

      // Approval without --out → error.
      const noOut = await run(`export ${id} --approve ${digest}`, cwd)
      expect(noOut.kind).toBe('error')

      // Wrong digest → export-approval-invalid.
      const badDigest = await run(`export ${id} --approve ${'0'.repeat(64)} --out exports/x.jsonl`, cwd)
      expect((badDigest as { text: string }).text).toContain('export-approval-invalid')

      // Correct approval → file written, digest stable, no content leak.
      const approved = await run(`export ${id} --approve ${digest} --out exports/x.jsonl`, cwd)
      expect(approved.kind).toBe('success')
      expect((approved as { text: string }).text).toContain('Written:')
      const content = await readFile(join(cwd, 'exports', 'x.jsonl'), 'utf8')
      expect(content).toContain('outcome-loop.export.v1')
      expect(content).not.toContain('导出目标目标')

      // Overwrite refused without --overwrite.
      const again = await run(`export ${id} --approve ${digest} --out exports/x.jsonl`, cwd)
      expect((again as { text: string }).text).toContain('already exists')
      const overwritten = await run(`export ${id} --approve ${digest} --out exports/x.jsonl --overwrite`, cwd)
      expect(overwritten.kind).toBe('success')

      // Path escape refused.
      const escape = await run(`export ${id} --approve ${digest} --out ../escape.jsonl`, cwd)
      expect((escape as { text: string }).text).toContain('escapes the workspace')

      // exports list shows the manifest.
      const exportsList = await run(`exports ${id}`, cwd)
      expect((exportsList as { text: string }).text).toContain('record(s)')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('delete requires --yes and removes sidecar data', async () => {
    const created = await run('new 删除测试', '/tmp')
    const id = extractContractId((created as { text: string }).text)
    const refused = await run(`delete ${id}`, '/tmp')
    expect(refused.kind).toBe('error')
    const deleted = await run(`delete ${id} --yes`, '/tmp')
    expect((deleted as { text: string }).text).toContain('Session log untouched')
    const status = await run(`status ${id}`, '/tmp')
    expect(status.kind).toBe('error')
  })
})

function extractContractId(text: string): string {
  const match = /(olc-[0-9a-f]{16})/.exec(text)
  expect(match).not.toBeNull()
  return match![1]!
}
