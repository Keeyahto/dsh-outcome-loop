/**
 * beta.5: skills candidates (§21.7.5) + contribution plugin (ADR-0005).
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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
import { Config as CoreConfig, type ConfigType } from '../../src/config.ts'
import { apply as applyContribute, Config as ContributeConfigSchema, buildContributionDataset } from '../../src/consumers/contribute.ts'
import { apply as applyCommands, Config as CommandsConfigSchema } from '../../src/consumers/commands.ts'
import { buildSkillsReport, topicsOf } from '../../src/dsh/skills.ts'
import { buildContract } from '../../src/domain/aggregate.ts'
import type { TaskContract } from '../../src/domain/types.ts'

let ctx: Context
let root: string
let cwd: string
let service: OutcomeLoopService
let registered: CommandDefinition[]

async function setup(withContribute = true, enabled = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'ol-b5-'))
  cwd = await mkdtemp(join(tmpdir(), 'ol-b5-ws-'))
  ctx = new Context()
  new Storage(ctx)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(outcomeDomainSpec)
  service = new OutcomeLoopService(ctx, {
    config: CoreConfig({}) as ConfigType,
    domain,
    ctx,
    version: '0.1.0-beta.5',
    dshVersion: '0.1.0-rc.7',
    trustedEnv: {},
  })
  registered = []
  ctx.provide('commands', { register: (def: CommandDefinition) => { registered.push(def) } } as never)
  applyCommands(ctx, CommandsConfigSchema({}) as never)
  if (withContribute) applyContribute(ctx, ContributeConfigSchema({ enabled }) as never)
}

beforeEach(async () => { await setup() })

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
    agent: { session: { id: 's-b5', header: { cwd } } },
    rawInput,
    signal: new AbortController().signal,
  } as never)
}

function idOf(text: string): string {
  const match = /(olc-[0-9a-f]{16})/.exec(text)
  expect(match).not.toBeNull()
  return match![1]!
}

async function seedContract(goal: string, kind: 'manual' | 'test-report'): Promise<string> {
  const created = await run(`new ${goal}`)
  const id = idOf((created as { text: string }).text)
  const spec = kind === 'manual'
    ? { kind: 'manual' as const, prompt: 'ok?' }
    : { kind: 'test-report' as const, framework: 'any' as const, minPassed: 1, maxFailed: 0 }
  await service.addCriterion(id as never, { description: `${kind} criterion`, kind, specification: spec })
  if (kind === 'test-report') {
    service.registry.ingestEvents('s-b5', [{
      type: 'tool/call', seq: Number(id.slice(-2)) + 1, time: 1000, data: { callId: `c${id.slice(-2)}`, name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }), turn: 1, step: 1 },
    }, {
      type: 'tool/result', seq: Number(id.slice(-2)) + 2, time: 2000, data: { message: { source: { kind: 'tool', callId: `c${id.slice(-2)}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'TAP version 13\n1..1\nok 1\n' }] }] } },
    }])
  }
  const verify = await service.verify({ contractId: id as never })
  if (kind === 'manual') await service.setDisposition({ contractId: id as never, status: 'accepted' })
  void verify
  return id
}

describe('skills candidates (spec §22: display-only)', () => {
  it('aggregates topics and counts criterion kinds', async () => {
    // Distinct goals sharing the 登录 topic (ids are goal-deterministic).
    await seedContract('修复登录页 bug', 'test-report')
    await seedContract('登录页样式问题修复', 'test-report')
    const report = await run('skills')
    const text = (report as { text: string }).text
    expect(text).toContain('Skills report: 2 contract(s)')
    expect(text).toContain('«登录»')
    expect(text).toContain('test-report')
    // Display-only: never claims to auto-apply.
    expect(text).toContain('never auto-applied')
  })

  it('proposes a candidate only when every passing contract of a topic shares a kind', () => {
    const mk = (goal: string): TaskContract => {
      const built = buildContract({ sessionId: 's', goalText: goal, criteria: [{ description: 't', kind: 'test-report', specification: { kind: 'test-report', framework: 'any', minPassed: 1, maxFailed: 0 } }] })
      if (!built.ok) throw new Error('build failed')
      return built.value
    }
    const a = mk('修复登录页 bug')
    const b = mk('修复登录页 bug')
    const report = buildSkillsReport(
      [a, b],
      () => ({ schemaVersion: 1, id: 'olr-1' as never, contractId: a.id, contractRevision: 1, startedAt: 1, results: [{ criterionId: a.criteria[0]!.id, status: 'pass' as const, evidenceIds: [], staleEvidenceIds: [], conflict: false }], status: 'passed' as const, labelStrength: 'strong' as const, reasons: [], source: 'passive' as const }),
      () => 0,
      1000,
    )
    expect(report.topics.some((t) => t.contracts >= 2)).toBe(true)
    expect(report.candidates.length).toBeGreaterThan(0)
    expect(report.candidates[0]?.supporting).toBeGreaterThanOrEqual(2)
    // Different topics never merge.
    const c = mk('写 README 文档')
    const mixed = buildSkillsReport([a, c], () => undefined, () => 0, 1000)
    expect(mixed.candidates).toHaveLength(0)
  })

  it('topic extraction is deterministic and CJK-aware', () => {
    expect(topicsOf('修复登录页 bug')).toContain('登录')
    expect(topicsOf('fix the login bug')).toContain('login')
    expect(topicsOf('the and with')).toHaveLength(0)
  })
})

describe('contribution plugin (ADR-0005)', () => {
  it('registers nothing when disabled', async () => {
    await setup(true, false)
    expect(registered.find((d) => d.name === 'contribute')).toBeUndefined()
  })

  it('preview → approve prepares a consented dataset; revoke deletes it', async () => {
    const id = await seedContract('贡献数据集任务', 'manual')
    const preview = await runContribute(`preview ${id}`)
    // preview is registered under 'contribute'
    expect(preview.kind).toBe('success')
    const digest = /digest ([0-9a-f]{64})/.exec((preview as { text: string }).text)?.[1]
    expect(digest).toBeDefined()

    const approved = await runContribute(`approve ${digest} ${id} --out dataset-1`)
    expect(approved.kind).toBe('success')
    const files = await readdir(join(cwd, 'dataset-1'))
    expect(files).toContain('manifest.json')
    expect(files).toContain('records.jsonl')
    const manifest = JSON.parse(await readFile(join(cwd, 'dataset-1', 'manifest.json'), 'utf8')) as {
      schema_version: string; consent_version: string; contract_id: string; withdrawal: string; summary_only: boolean
    }
    expect(manifest.schema_version).toBe('outcome-loop.contribution.v1')
    expect(manifest.consent_version).toBe('outcome-loop.consent.v1')
    expect(manifest.contract_id).toBe(id)
    expect(manifest.withdrawal).toContain('delete')
    const records = await readFile(join(cwd, 'dataset-1', 'records.jsonl'), 'utf8')
    expect(records).toContain('outcome-loop.export.v1')
    expect(records).not.toContain('贡献数据集任务') // no goal text in records

    // Re-approve same dir refused.
    const again = await runContribute(`approve ${digest} ${id} --out dataset-1`)
    expect(again.kind).toBe('error')

    // Summary-only writes aggregates only.
    const summary = await runContribute(`approve ${digest} ${id} --out dataset-summary --summary-only`)
    expect(summary.kind).toBe('success')
    const summaryFiles = await readdir(join(cwd, 'dataset-summary'))
    expect(summaryFiles).toContain('summary.json')
    expect(summaryFiles).not.toContain('records.jsonl')

    // Revoke deletes the directory.
    const revoked = await runContribute(`revoke ${id} --out dataset-1 --yes`)
    expect(revoked.kind).toBe('success')
    await expect(readdir(join(cwd, 'dataset-1'))).rejects.toThrow()
  })

  it('path escapes are refused', async () => {
    const id = await seedContract('x', 'manual')
    const bad = await runContribute(`approve ${'0'.repeat(64)} ${id} --out ../escape`)
    expect(bad.kind).toBe('error')
  })

  it('the deterministic gate blocks record content that needs redaction', () => {
    const manifest = {
      schema_version: 'outcome-loop.contribution.v1' as const,
      consent_version: 'outcome-loop.consent.v1' as const,
      created_at: 1,
      contract_id: 'olc-x',
      record_count: 1,
      summary_only: false,
      fields: ['a'],
      license: 'private-only',
      recipient: 'user',
      purpose: 'x',
      retention: 'user',
      compensation: 'none',
      withdrawal: 'delete',
      preview_digest: '0'.repeat(64),
      plugin_version: '0.1.0-beta.5',
      dsh_version: '0.1.0-rc.7',
      sensitivity_counts: {},
      redaction_changes: 0,
    }
    const leaked = buildContributionDataset(['{"token":"sk-abcdefghijklmnopqrstuvwxyz123456"}'], manifest, { redactSecrets: true, redactPersonalData: true })
    expect(leaked.ok).toBe(false)
    if (!leaked.ok) expect(leaked.error.code).toBe('policy-denied')
    const clean = buildContributionDataset(['{"ok":true}'], manifest, { redactSecrets: true, redactPersonalData: true })
    expect(clean.ok).toBe(true)
  })
})

async function runContribute(rawInput: string) {
  const def = registered.find((d) => d.name === 'contribute')
  expect(def).toBeDefined()
  return def!.handler({
    commandId: 'cmd-1' as never,
    agent: { session: { id: 's-b5', header: { cwd } } },
    rawInput,
    signal: new AbortController().signal,
  } as never)
}
