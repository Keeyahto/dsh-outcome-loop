/**
 * TAP/JUnit parsers + cost + contract file format (v0.1.0-beta.3 features).
 */

import { describe, expect, it } from 'vitest'

import { looksLikeTap, parseTap, tapSatisfies } from '../../src/verification/adapters/tap.ts'
import { looksLikeJunit, parseJunit, junitSatisfies } from '../../src/verification/adapters/junit.ts'
import { costOf, usageFromFacts, type PriceTableEntry } from '../../src/dsh/token-bridge.ts'
import { parseContractFile, serializeContract, CONTRACT_FILE_VERSION } from '../../src/export/contract.ts'
import { buildContract } from '../../src/domain/aggregate.ts'
import type { SessionFactLog } from '../../src/domain/types.ts'

describe('TAP parser', () => {
  it('parses TAP v13 streams into counts', () => {
    const tap = `TAP version 13
1..4
ok 1 - adds numbers
ok 2 - subtracts
not ok 3 - divides by zero
ok 4 - multiplies # SKIP slow
`
    expect(looksLikeTap(tap)).toBe(true)
    const counts = parseTap(tap)
    expect(counts).toEqual({ passed: 2, failed: 1, skipped: 1, planned: 4 })
    expect(tapSatisfies(counts!, 2, 1)).toBe(true)
    expect(tapSatisfies(counts!, 3, 0)).toBe(false)
  })

  it('rejects non-TAP text', () => {
    expect(looksLikeTap('All tests passed')).toBe(false)
    expect(parseTap('All tests passed')).toBeUndefined()
    expect(parseTap('')).toBeUndefined()
  })
})

describe('JUnit parser', () => {
  const xml = `<?xml version="1.0"?>
<testsuites tests="4" failures="1">
  <testsuite name="math" tests="4" failures="1">
    <testcase name="adds" classname="math"/>
    <testcase name="subtracts" classname="math"/>
    <testcase name="divides" classname="math">
      <failure message="by zero">stack</failure>
    </testcase>
    <testcase name="multiplies" classname="math">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`
  it('parses testcase counts including failure/skipped', () => {
    expect(looksLikeJunit(xml)).toBe(true)
    const counts = parseJunit(xml)
    expect(counts).toEqual({ passed: 2, failed: 1, skipped: 1, tests: 4 })
    expect(junitSatisfies(counts!, 2, 0)).toBe(false)
    expect(junitSatisfies(counts!, 2, 1)).toBe(true)
  })

  it('rejects non-JUnit text', () => {
    expect(looksLikeJunit('<html></html>')).toBe(false)
    expect(parseJunit('nope')).toBeUndefined()
  })
})

describe('cost (spec §8.6)', () => {
  const table: readonly PriceTableEntry[] = [{
    provider: 'deepseek',
    model: 'deepseek-chat',
    currency: 'CNY',
    pricePerMillionInput: 2,
    pricePerMillionOutput: 8,
    effectiveFrom: 0,
    source: 'https://example.invalid/pricing/v1',
  }]

  it('reports tokens only without a price table', () => {
    expect(costOf({ usageKind: 'exact', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, calls: 1 }, [], Date.now())).toBeUndefined()
  })

  it('computes cost only for exact usage with a matching entry', () => {
    const cost = costOf({ usageKind: 'exact', inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000, calls: 1, provider: 'deepseek', model: 'deepseek-chat' }, table, Date.now())
    expect(cost).toBeDefined()
    expect(cost?.currency).toBe('CNY')
    expect(cost?.inputCost).toBe(2)
    expect(cost?.outputCost).toBe(4)
    expect(cost?.totalCost).toBe(6)
  })

  it('never estimates: estimate/unknown usage yields no cost', () => {
    expect(costOf({ usageKind: 'estimate', totalTokens: 100, calls: 1 }, table, Date.now())).toBeUndefined()
    expect(costOf({ usageKind: 'unknown', calls: 0 }, table, Date.now())).toBeUndefined()
  })

  it('honors effectiveFrom and provider/model matching', () => {
    const future = [{ ...table[0]!, effectiveFrom: Date.now() + 86_400_000 }]
    expect(costOf({ usageKind: 'exact', inputTokens: 1, outputTokens: 0, totalTokens: 1, calls: 1 }, future, Date.now())).toBeUndefined()
    const otherProvider = [{ ...table[0]!, provider: 'other' }]
    expect(costOf({ usageKind: 'exact', inputTokens: 1, outputTokens: 0, totalTokens: 1, calls: 1, provider: 'deepseek', model: 'deepseek-chat' }, otherProvider, Date.now())).toBeUndefined()
  })

  it('usageFromFacts carries route lineage for matching', () => {
    const log: SessionFactLog = {
      sessionId: 's',
      facts: [
        { kind: 'route', seq: 1, time: 1, provider: 'deepseek', model: 'deepseek-chat' },
        { kind: 'usage', seq: 2, time: 2, inputTokens: 100, outputTokens: 50, totalTokens: 150, usageKind: 'exact' },
      ],
      seqStart: 1,
      seqEnd: 2,
      workspaceEpoch: 0,
    }
    const usage = usageFromFacts(log)
    expect(usage.provider).toBe('deepseek')
    expect(usage.model).toBe('deepseek-chat')
    expect(usage.calls).toBe(1)
  })
})

describe('contract file format', () => {
  it('serializes and round-trips a contract', () => {
    const built = buildContract({
      sessionId: 's1',
      goalText: '修复 bug',
      criteria: [{
        description: '测试通过',
        kind: 'test-report',
        specification: { kind: 'test-report', framework: 'tap', minPassed: 1, maxFailed: 0, command: 'pnpm test' },
      }],
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const json = serializeContract(built.value)
    expect(json).toContain(CONTRACT_FILE_VERSION)
    // The contract file is user-owned (unlike exports): explicit goal text
    // is part of the contract and round-trips.
    expect(json).toContain('修复 bug')
    const parsed = parseContractFile(json, 's1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.criteria).toHaveLength(1)
    expect(parsed.value.goalText).toBe('修复 bug')
    expect(parsed.value.criteria[0]?.specification).toMatchObject({ kind: 'test-report', command: 'pnpm test' })
  })

  it('rejects invalid JSON and session mismatches', () => {
    const bad = parseContractFile('{nope', 's1')
    expect(bad.ok).toBe(false)
    const mismatch = parseContractFile(JSON.stringify({ schema_version: CONTRACT_FILE_VERSION, session_id: 'other' }), 's1')
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('invalid-input')
  })

  it('rejects unknown schema versions', () => {
    const future = parseContractFile(JSON.stringify({ schema_version: 'outcome-loop.contract.v2' }), 's1')
    expect(future.ok).toBe(false)
  })
})
