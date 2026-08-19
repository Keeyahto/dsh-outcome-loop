/**
 * Verification engine tests: passive adapter, implied verdicts, policy gates,
 * active runner primitives (security-relevant — target high branch coverage).
 */

import { isAbsolute, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AcceptanceCriterion, Evidence, TaskContract } from '../../src/domain/types.ts'
import { buildContract } from '../../src/domain/aggregate.ts'
import { verifyPassive } from '../../src/verification/adapters/passive.ts'
import { countDiagnostics, digestFile, parsePorcelain, resolveScopedPath, runCommand, splitArgs } from '../../src/verification/adapters/active.ts'
import { decideActiveRun } from '../../src/verification/policy.ts'
import { impliesVerdict } from '../../src/verification/engine.ts'

function criterion(over: Partial<AcceptanceCriterion>): AcceptanceCriterion {
  return {
    id: 'olcr-1' as never,
    description: 'c',
    kind: over.specification?.kind ?? 'manual',
    required: true,
    severity: 'blocking',
    specification: { kind: 'manual', prompt: 'c' },
    freshness: { invalidateOnWorkspaceChange: false },
    ...over,
  }
}

function contract(over: Partial<TaskContract> = {}): TaskContract {
  const built = buildContract({ sessionId: 'session-1', goalText: 'g' })
  if (!built.ok) throw new Error('contract build failed')
  return { ...built.value, ...over }
}

function commandFactLog(exitCode: number, label = 'pnpm test', seq = 5) {
  return {
    sessionId: 'session-1',
    facts: [{
      kind: 'tool-result' as const,
      seq,
      time: seq * 1000,
      callId: 'call-1',
      name: 'bash',
      isError: exitCode !== 0,
      exitCode,
      commandLabel: label,
      outputBytes: 10,
    }],
    seqStart: 1,
    seqEnd: seq,
    workspaceEpoch: 0,
  }
}

describe('verifyPassive (spec §12.2)', () => {
  it('command-exit pass on matching observed command', () => {
    const c = criterion({ specification: { kind: 'command-exit', command: 'pnpm test', expectExitCode: 0 } })
    const verdict = verifyPassive(c, commandFactLog(0), [])
    expect(verdict.status).toBe('pass')
    expect(verdict.facts[0]).toMatchObject({ kind: 'command', exitCode: 0 })
  })

  it('command-exit fail on non-zero exit', () => {
    const c = criterion({ specification: { kind: 'command-exit', command: 'pnpm test', expectExitCode: 0 } })
    const verdict = verifyPassive(c, commandFactLog(1), [])
    expect(verdict.status).toBe('fail')
  })

  it('command-exit unknown when the command was never observed (no rerun)', () => {
    const c = criterion({ specification: { kind: 'command-exit', command: 'pnpm test', expectExitCode: 0 } })
    const verdict = verifyPassive(c, commandFactLog(0, 'ls'), [])
    expect(verdict.status).toBe('unknown')
    expect(verdict.note).toContain('no observed command matched')
  })

  it('test-report uses test-command exit codes', () => {
    const c = criterion({ specification: { kind: 'test-report', framework: 'any', minPassed: 1, maxFailed: 0 } })
    expect(verifyPassive(c, commandFactLog(0, 'pnpm test'), []).status).toBe('pass')
    expect(verifyPassive(c, commandFactLog(2, 'pnpm test'), []).status).toBe('fail')
  })

  it('file-state criteria consult prior evidence, never rerun', () => {
    const c = criterion({ specification: { kind: 'file-exists', path: 'src/index.ts' } })
    const prior: Evidence[] = [{
      schemaVersion: 1,
      id: 'ole-p' as never,
      contractId: 'olc-1' as never,
      source: 'import',
      observedAt: 100,
      workspaceState: { epoch: 0 },
      fact: { kind: 'file-state', path: 'src/index.ts', exists: true },
      strength: 'medium',
      sensitivity: 'confidential',
    }]
    expect(verifyPassive(c, { sessionId: 's', facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 }, prior).status).toBe('pass')
    expect(verifyPassive(c, { sessionId: 's', facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 }, []).status).toBe('unknown')
  })

  it('manual criteria defer to disposition', () => {
    const c = criterion({ specification: { kind: 'manual', prompt: 'user confirms' } })
    const verdict = verifyPassive(c, { sessionId: 's', facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 }, [])
    expect(verdict.status).toBe('unknown')
    expect(verdict.note).toContain('disposition')
  })

  it('git-scope checks violations from prior evidence', () => {
    const c = criterion({
      specification: { kind: 'git-scope', allowedPrefixes: ['src/'], forbiddenPrefixes: ['node_modules/'] },
    })
    const prior: Evidence[] = [{
      schemaVersion: 1,
      id: 'ole-g' as never,
      contractId: 'olc-1' as never,
      source: 'verifier',
      observedAt: 100,
      workspaceState: { epoch: 0 },
      fact: { kind: 'git-scope', changedPaths: ['src/a.ts'], violations: [] },
      strength: 'strong',
      sensitivity: 'internal',
    }]
    expect(verifyPassive(c, { sessionId: 's', facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 }, prior).status).toBe('pass')
    const bad: Evidence[] = [{
      ...prior[0]!,
      fact: { kind: 'git-scope', changedPaths: ['node_modules/x.js'], violations: ['node_modules/x.js'] },
    }]
    expect(verifyPassive(c, { sessionId: 's', facts: [], seqStart: 0, seqEnd: 0, workspaceEpoch: 0 }, bad).status).toBe('fail')
  })

  it('unknown without any fact log', () => {
    const c = criterion({ specification: { kind: 'command-exit', command: 'x', expectExitCode: 0 } })
    expect(verifyPassive(c, undefined, []).status).toBe('unknown')
  })
})

describe('impliesVerdict', () => {
  it('command facts imply pass/fail against command-exit specs', () => {
    const spec = { kind: 'command-exit' as const, command: 'x', expectExitCode: 0 }
    expect(impliesVerdict({ kind: 'command', argvDigest: 'd', commandLabel: 'x', exitCode: 0 }, spec)).toBe('pass')
    expect(impliesVerdict({ kind: 'command', argvDigest: 'd', commandLabel: 'x', exitCode: 1 }, spec)).toBe('fail')
  })

  it('file-state facts imply pass/fail for exists/absent/digest', () => {
    expect(impliesVerdict({ kind: 'file-state', path: 'a', exists: true }, { kind: 'file-exists', path: 'a' })).toBe('pass')
    expect(impliesVerdict({ kind: 'file-state', path: 'a', exists: true }, { kind: 'file-absent', path: 'a' })).toBe('fail')
    expect(impliesVerdict({ kind: 'file-state', path: 'a', exists: true, digest: 'abc' }, { kind: 'file-digest', path: 'a', algorithm: 'sha256', digest: 'abc' })).toBe('pass')
  })

  it('user-confirmation implies manual verdicts', () => {
    expect(impliesVerdict({ kind: 'user-confirmation', disposition: 'accepted' }, { kind: 'manual', prompt: 'x' })).toBe('pass')
    expect(impliesVerdict({ kind: 'user-confirmation', disposition: 'rejected' }, { kind: 'manual', prompt: 'x' })).toBe('fail')
  })

  it('verifier facts carry their verdict', () => {
    expect(impliesVerdict({ kind: 'verifier', providerId: 'p', verdict: 'pass', detail: '' }, { kind: 'custom', providerId: 'p', params: {} })).toBe('pass')
  })
})

describe('decideActiveRun (spec §12.3)', () => {
  const policy = { deploymentAutoRun: false, trustedEnv: {}, verifierVersion: 'v1' }

  it('denied by default (deployment autoRun=false)', () => {
    const decision = decideActiveRun(contract(), 'command-exit', policy)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe('policy-denied')
  })

  it('denied when contract policy or scope forbids', () => {
    const policyOn = { ...policy, deploymentAutoRun: true }
    const c = contract({ verificationPolicy: { autoRun: false, commandTimeoutMs: 1000, maxCommandOutputBytes: 1024, allowedVerifierIds: [] } })
    expect(decideActiveRun(c, 'command-exit', policyOn).allowed).toBe(false)
  })

  it('denied without an absolute workspace root', () => {
    const policyOn = { ...policy, deploymentAutoRun: true }
    const c = contract({
      verificationPolicy: { autoRun: true, commandTimeoutMs: 1000, maxCommandOutputBytes: 1024, allowedVerifierIds: [] },
      scope: { workspaceRoot: '', pathPrefixes: [], allowActiveVerification: true },
    })
    const decision = decideActiveRun(c, 'command-exit', policyOn)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe('permission-denied')
  })

  it('allowed only when every gate is open', () => {
    const policyOn = { ...policy, deploymentAutoRun: true }
    const c = contract({
      verificationPolicy: { autoRun: true, commandTimeoutMs: 1000, maxCommandOutputBytes: 1024, allowedVerifierIds: ['command-exit'] },
      scope: { workspaceRoot: '/tmp/ws', pathPrefixes: [], allowActiveVerification: true },
    })
    const decision = decideActiveRun(c, 'command-exit', policyOn)
    expect(decision.allowed).toBe(true)
  })
})

describe('active runner primitives', () => {
  it('splitArgs handles quotes and whitespace', () => {
    expect(splitArgs('pnpm test --run')).toEqual(['pnpm', 'test', '--run'])
    expect(splitArgs('echo "hello world"')).toEqual(['echo', 'hello world'])
    expect(splitArgs("git commit -m 'fix thing'")).toEqual(['git', 'commit', '-m', 'fix thing'])
    expect(splitArgs('')).toEqual([])
  })

  it('runCommand returns exit code and capped output', async () => {
    const outcome = await runCommand(['node', '-e', 'console.log("hi")'], {
      cwd: process.cwd(), scopeRoot: process.cwd(), timeoutMs: 5000, maxOutputBytes: 1024, env: { PATH: process.env.PATH ?? '' },
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toContain('hi')
  })

  it('runCommand honors timeout and output caps', async () => {
    const outcome = await runCommand(['node', '-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(), scopeRoot: process.cwd(), timeoutMs: 50, maxOutputBytes: 1024, env: { PATH: process.env.PATH ?? '' },
    })
    expect(outcome.timedOut).toBe(true)
    const capped = await runCommand(['node', '-e', 'console.log("x".repeat(5000))'], {
      cwd: process.cwd(), scopeRoot: process.cwd(), timeoutMs: 5000, maxOutputBytes: 100, env: { PATH: process.env.PATH ?? '' },
    })
    expect(capped.truncated).toBe(true)
    expect(capped.output.length).toBeLessThanOrEqual(100)
  })

  it('resolveScopedPath rejects escapes', () => {
    // Use a real absolute scope root on the current platform so that
    // node:path's resolve() yields a platform-native absolute path that
    // we can compare against without locking the test to a specific OS.
    // The previous implementation hardcoded POSIX '/ws' which only worked
    // when the test ran on POSIX CI.
    const scopeRoot = isAbsolute(process.cwd()) ? process.cwd() : '/tmp'
    const expected = resolve(scopeRoot, 'src/a.ts')
    expect(resolveScopedPath(scopeRoot, 'src/a.ts')).toBe(expected)
    expect(resolveScopedPath(scopeRoot, '../escape.ts')).toBeUndefined()
    // /etc/passwd on POSIX escapes the cwd scope; on Windows C:/etc/passwd
    // is an absolute path outside the cwd scope and is also rejected.
    expect(resolveScopedPath(scopeRoot, resolve(scopeRoot, '../etc/passwd'))).toBeUndefined()
  })

  it('parsePorcelain extracts paths', () => {
    expect(parsePorcelain(' M src/a.ts\n?? new.txt\nR  old.txt -> new/name.txt\n')).toEqual(['src/a.ts', 'new.txt', 'new/name.txt'])
  })

  it('countDiagnostics reads summary and line formats', () => {
    expect(countDiagnostics('Found 3 errors in 2 files')).toEqual({ errors: 3, warnings: 0 })
    expect(countDiagnostics('5 warnings\n1 error')).toEqual({ errors: 1, warnings: 5 })
    expect(countDiagnostics('src/a.ts:1:1 error TS2322\nsrc/b.ts:2:2 warning TS6133')).toEqual({ errors: 1, warnings: 1 })
  })

  it('digestFile computes sha256', async () => {
    const { writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const path = join(tmpdir(), `outcome-loop-digest-${Date.now()}.txt`)
    await writeFile(path, 'hello')
    const digest = await digestFile(path)
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    await rm(path, { force: true })
  })
})
