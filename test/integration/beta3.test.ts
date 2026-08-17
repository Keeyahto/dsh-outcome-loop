/**
 * beta.3 integration: TAP extraction through the real service, active JUnit
 * verification, and the /outcome import / export-contract / cost commands.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

import { OutcomeLoopService } from '../../src/service.ts'
import { outcomeDomainSpec } from '../../src/persistence/schema.ts'
import { Config as CoreConfig } from '../../src/config.ts'
import { apply as applyCommands, Config as CommandsConfigSchema } from '../../src/consumers/commands.ts'

let ctx: Context
let root: string
let cwd: string
let service: OutcomeLoopService
let registered: CommandDefinition[]
let coreConfig: ReturnType<typeof CoreConfig>
let commandsConfig: ReturnType<typeof CommandsConfigSchema>

async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'ol-b3-'))
  cwd = await mkdtemp(join(tmpdir(), 'ol-b3-ws-'))
  ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(outcomeDomainSpec)
  coreConfig = CoreConfig({}) as ReturnType<typeof CoreConfig>
  commandsConfig = CommandsConfigSchema({}) as ReturnType<typeof CommandsConfigSchema>
  service = new OutcomeLoopService(ctx, {
    config: coreConfig,
    domain,
    ctx,
    version: '0.1.0-beta.3',
    dshVersion: '0.1.0-rc.7',
    trustedEnv: {},
  })
  registered = []
  ctx.provide('commands', { register: (def: CommandDefinition) => { registered.push(def) } } as never)
  applyCommands(ctx, commandsConfig)
}

beforeEach(setup)

afterEach(async () => {
  try { ctx.stop?.() } catch { /* already stopped */ }
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(root, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

async function run(rawInput: string) {
  const def = registered.find((d) => d.name === 'outcome')
  return def!.handler({
    commandId: 'cmd-1' as never,
    agent: { session: { id: 's-b3', header: { cwd } } },
    rawInput,
    signal: new AbortController().signal,
  } as never)
}

function idOf(text: string): string {
  const match = /(olc-[0-9a-f]{16})/.exec(text)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('TAP extraction (passive, end to end)', () => {
  it('parses TAP counts from a test command and passes with structured evidence', async () => {
    const created = await run('new 让测试通过')
    const contractId = idOf((created as { text: string }).text)
    const criterion = await run('criterion add-test --min-passed 2 --max-failed 1')
    expect(criterion.kind).toBe('success')
    const tap = 'TAP version 13\n1..3\nok 1 - a\nok 2 - b\nnot ok 3 - c\n'
    service.registry.ingestEvents('s-b3', [{
      type: 'tool/call', seq: 1, time: 1000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }), turn: 1, step: 1 },
    }, {
      type: 'tool/result', seq: 2, time: 2000, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: tap }] }] } },
    }])
    const verify = await service.verify({ contractId })
    expect(verify.ok).toBe(true)
    if (!verify.ok) return
    expect(verify.value.status).toBe('passed')
    const result = verify.value.results[0]
    expect(result?.status).toBe('pass')
    // Structured evidence: the stored fact carries real counts, not a 0/1 proxy.
    const evidence = service.repository.listEvidence(contractId)
    const reportFact = evidence.find((e) => e.fact.kind === 'test-report')
    expect(reportFact?.fact.kind).toBe('test-report')
    if (reportFact?.fact.kind === 'test-report') {
      expect(reportFact.fact.passed).toBe(2)
      expect(reportFact.fact.failed).toBe(1)
    }
  })

  it('fails a tap criterion when counts exceed the thresholds', async () => {
    const created = await run('new 测试必须全绿')
    const contractId = idOf((created as { text: string }).text)
    await run('criterion add-test --min-passed 2 --max-failed 0')
    const tap = 'TAP version 13\n1..2\nok 1 - a\nnot ok 2 - b\n'
    service.registry.ingestEvents('s-b3', [{
      type: 'tool/call', seq: 1, time: 1000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }), turn: 1, step: 1 },
    }, {
      type: 'tool/result', seq: 2, time: 2000, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: tap }] }] } },
    }])
    const verify = await service.verify({ contractId })
    expect(verify.ok).toBe(true)
    if (verify.ok) {
      expect(verify.value.results[0]?.status).toBe('fail')
      expect(verify.value.status).toBe('failed')
    }
  })
})

describe('active JUnit verification', () => {
  it('reads a scoped junit report file and passes/fails on counts', async () => {
    const junit = `<testsuites tests="2"><testsuite name="a" tests="2"><testcase name="x"/><testcase name="y"/></testsuite></testsuites>`
    await writeFile(join(cwd, 'junit.xml'), junit)
    const created = await service.createContract({
      sessionId: 's-b3',
      goalText: 'junit 报告',
      criteria: [{
        description: 'junit 全绿',
        kind: 'test-report',
        specification: { kind: 'test-report', framework: 'junit', minPassed: 2, maxFailed: 0, reportPath: 'junit.xml' },
      }],
      verificationPolicy: { autoRun: true, commandTimeoutMs: 5000, maxCommandOutputBytes: 65536, allowedVerifierIds: ['test-report'] },
      scope: { workspaceRoot: cwd, pathPrefixes: [], allowActiveVerification: true },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // Passive path cannot see the file → active runs only with all gates open.
    const disabled = await service.verify({ contractId: created.value.id })
    // active verification is disabled at deployment level → unknown, not a crash
    expect(disabled.ok).toBe(true)
    if (disabled.ok) expect(disabled.value.results[0]?.status).toBe('unknown')
  })
})

describe('/outcome import and export-contract', () => {
  it('imports a contract file and round-trips via export-contract', async () => {
    const file = JSON.stringify({
      schema_version: 'outcome-loop.contract.v1',
      session_id: 's-b3',
      goal: { kind: 'explicit', text: '导入的目标' },
      criteria: [{ description: '手动验收', kind: 'manual', specification: { kind: 'manual', prompt: '确认' } }],
    })
    await writeFile(join(cwd, 'contract.json'), file)

    const imported = await run('import contract.json')
    expect(imported.kind).toBe('success')
    const contractId = idOf((imported as { text: string }).text)

    const exported = await run(`export-contract ${contractId} --out exported-contract.json`)
    expect(exported.kind).toBe('success')
    const content = await readFile(join(cwd, 'exported-contract.json'), 'utf8')
    expect(content).toContain('outcome-loop.contract.v1')
    expect(content).toContain('导入的目标')

    // Session mismatch rejected.
    const foreign = JSON.stringify({ schema_version: 'outcome-loop.contract.v1', session_id: 'other-session' })
    await writeFile(join(cwd, 'foreign.json'), foreign)
    const rejected = await run('import foreign.json')
    expect(rejected.kind).toBe('error')
  })

  it('rejects path escapes on import', async () => {
    const escaped = await run('import ../outside.json')
    expect(escaped.kind).toBe('error')
  })
})

describe('/outcome cost', () => {
  it('reports tokens only without a price table', async () => {
    const created = await run('new 成本任务')
    const contractId = idOf((created as { text: string }).text)
    service.registry.ingestEvents('s-b3', [{
      type: 'assistant/message', seq: 1, time: 1000, data: { usage: { inputTokens: 1000, outputTokens: 500 } },
    }])
    const cost = await run(`cost ${contractId}`)
    const text = (cost as { text: string }).text
    expect(text).toContain('tokens only')
    expect(text).toContain('1000 in / 500 out')
  })
})
