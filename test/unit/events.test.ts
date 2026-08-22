/**
 * Event normalization tests (spec §8.2, §13): the hot path must be
 * constant-size, content-free and tolerant of unknown event types.
 */

import { describe, expect, it } from 'vitest'

import { commandLabelOf, createExtractorState, lastExitCode, normalizeEvent, isExecTool, isTestCommand, isWriteTool, textOfBlocks } from '../../src/dsh/events.ts'

const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: seq * 1000, data })

describe('normalizeEvent', () => {
  it('turn/start and turn/end produce turn facts with reason kind', () => {
    const state = createExtractorState()
    const start = normalizeEvent(event('turn/start', 1, { turn: 3 }), state)
    const end = normalizeEvent(event('turn/end', 2, { turn: 3, reason: { kind: 'completed' } }), state)
    expect(start).toEqual([{ kind: 'turn-start', seq: 1, time: 1000, turn: 3 }])
    expect(end).toEqual([{ kind: 'turn-end', seq: 2, time: 2000, turn: 3, reasonKind: 'completed' }])
  })

  it('tool call/result pairing extracts exit code and never copies output', () => {
    const state = createExtractorState()
    const call = normalizeEvent(event('tool/call', 3, {
      callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', description: 'run tests' }), turn: 1, step: 1,
    }), state)
    expect(call[0]?.kind).toBe('tool-call')
    const text = 'All tests passed\n[exit code: 0]'
    const result = normalizeEvent(event('tool/result', 4, {
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          content: [{ type: 'text', text }],
        }],
      },
    }), state)
    const fact = result[0]
    expect(fact?.kind).toBe('tool-result')
    if (fact?.kind === 'tool-result') {
      expect(fact.exitCode).toBe(0)
      expect(fact.commandLabel).toBe('pnpm test')
      expect(fact.outputBytes).toBe(text.length)
      expect(fact.isError).toBe(false)
      expect(fact.durationMs).toBe(1000)
    }
  })

  it('assistant usage becomes an exact usage fact', () => {
    const state = createExtractorState()
    const facts = normalizeEvent(event('assistant/message', 5, {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
    }), state)
    expect(facts[0]).toMatchObject({ kind: 'usage', usageKind: 'exact', inputTokens: 10, outputTokens: 5, totalTokens: 17 })
  })

  it('feedback/record becomes a digest only (never the text)', () => {
    const state = createExtractorState()
    const facts = normalizeEvent(event('feedback/record', 6, { text: 'this is my private feedback note' }), state)
    expect(facts[0]?.kind).toBe('feedback')
    if (facts[0]?.kind === 'feedback') {
      expect(facts[0].textDigest).not.toContain('private feedback')
      expect(facts[0].textDigest).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('request/context becomes route lineage', () => {
    const state = createExtractorState()
    const facts = normalizeEvent(event('request/context', 7, { provider: 'deepseek', model: 'deepseek-chat' }), state)
    expect(facts[0]).toMatchObject({ kind: 'route', provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('user/message keeps only source (never content)', () => {
    const state = createExtractorState()
    const facts = normalizeEvent(event('user/message', 8, { source: { kind: 'user' }, content: [] }), state)
    expect(facts[0]).toMatchObject({ kind: 'user-message', source: 'user' })
  })

  it('write tools bump the workspace epoch marker', () => {
    const state = createExtractorState()
    normalizeEvent(event('tool/call', 9, { callId: 'c2', name: 'edit', arguments: '{}', turn: 1, step: 1 }), state)
    const facts = normalizeEvent(event('tool/result', 10, { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } }), state)
    expect(facts.some((f) => f.kind === 'file-change-marker')).toBe(true)
  })

  // BUG regression: a successful `run_code` (or any exec tool) must
  // bump the workspace epoch, because its shell script may have mutated
  // the workspace passively. Without this, evidence captured before
  // the script ran stays "fresh" beside new evidence captured after,
  // and the verifier returns `INCONCLUSIVE` forever (engine.ts
  // `passRows && failRows` conflict rule). The pre-fix behavior was
  // to trust only explicit write tools (`edit`, `write_file`, …),
  // which misses `bash`, `run_code`, `sh`, `exec`, and any DSH
  // exec-style tool that mutates through filesystem side effects.
  it('M1 freshness — successful `run_code` bumps the workspace epoch marker', () => {
    const state = createExtractorState()
    normalizeEvent(event('tool/call', 20, {
      callId: 'c-run-code-1', name: 'run_code', arguments: JSON.stringify({ code: "writeFileSync('a.txt', 'mutated')" }), turn: 1, step: 1,
    }), state)
    const facts = normalizeEvent(event('tool/result', 21, {
      message: {
        source: { kind: 'tool', callId: 'c-run-code-1' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }],
      },
    }), state)
    expect(facts.some((f) => f.kind === 'file-change-marker')).toBe(true)
  })

  it('M1 freshness — successful `bash` shell tool bumps the workspace epoch marker', () => {
    const state = createExtractorState()
    normalizeEvent(event('tool/call', 22, {
      callId: 'c-bash-1', name: 'bash', arguments: JSON.stringify({ command: "echo hello > a.txt" }), turn: 1, step: 1,
    }), state)
    const facts = normalizeEvent(event('tool/result', 23, {
      message: {
        source: { kind: 'tool', callId: 'c-bash-1' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }],
      },
    }), state)
    expect(facts.some((f) => f.kind === 'file-change-marker')).toBe(true)
  })

  it('M1 freshness — successful `sh` / `exec` / `pwsh` shell tools also bump', () => {
    for (const name of ['sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'terminal', 'exec', 'run_command']) {
      const state = createExtractorState()
      normalizeEvent(event('tool/call', 30, {
        callId: `c-${name}`, name, arguments: JSON.stringify({ command: 'true' }), turn: 1, step: 1,
      }), state)
      const facts = normalizeEvent(event('tool/result', 31, {
        message: {
          source: { kind: 'tool', callId: `c-${name}` },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }],
        },
      }), state)
      expect(facts.some((f) => f.kind === 'file-change-marker')).toBe(true)
    }
  })

  it('M1 freshness — a FAILED `bash` still bumps the workspace epoch (half-written state is opaque)', () => {
    const state = createExtractorState()
    normalizeEvent(event('tool/call', 24, {
      callId: 'c-bash-fail', name: 'bash', arguments: JSON.stringify({ command: "echo partial > a.txt; exit 1" }), turn: 1, step: 1,
    }), state)
    const facts = normalizeEvent(event('tool/result', 25, {
      message: {
        source: { kind: 'tool', callId: 'c-bash-fail' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'partial\n[exit code: 1]' }] }],
      },
    }), state)
    expect(facts.some((f) => f.kind === 'file-change-marker')).toBe(true)
  })

  it('non-exec, non-write tools (e.g. web_search) do NOT bump the workspace epoch', () => {
    const state = createExtractorState()
    normalizeEvent(event('tool/call', 26, {
      callId: 'c-web', name: 'web_search', arguments: JSON.stringify({ query: 'x' }), turn: 1, step: 1,
    }), state)
    const facts = normalizeEvent(event('tool/result', 27, {
      message: {
        source: { kind: 'tool', callId: 'c-web' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }],
      },
    }), state)
    expect(facts.some((f) => f.kind === 'file-change-marker')).toBe(false)
  })

  it('unknown event types are tolerated (never crash)', () => {
    const state = createExtractorState()
    const facts = normalizeEvent(event('future/event-type', 11, { anything: true }), state)
    expect(facts[0]?.kind).toBe('unknown')
    if (facts[0]?.kind === 'unknown') expect(facts[0].type).toBe('future/event-type')
  })

  it('orphan tool results (no matching call) are safe', () => {
    const state = createExtractorState()
    const facts = normalizeEvent(event('tool/result', 12, { message: { source: { kind: 'tool', callId: 'ghost' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x' }] }] } }), state)
    expect(facts[0]?.kind).toBe('tool-result')
    expect(facts[0]).toMatchObject({ name: 'unknown-tool', exitCode: undefined })
  })
})

describe('helpers', () => {
  it('commandLabelOf parses command fields and bounds length', () => {
    expect(commandLabelOf('bash', JSON.stringify({ command: '  ls   -la  ' }))).toBe('ls -la')
    expect(commandLabelOf('run_code', JSON.stringify({ code: 'console.log(1)' }))).toBe('console.log(1)')
    expect(commandLabelOf('bash', 'not-json')).toBe('bash')
    const long = 'x'.repeat(500)
    expect(commandLabelOf('bash', JSON.stringify({ command: long })).length).toBeLessThanOrEqual(201)
  })

  it('lastExitCode finds the last marker', () => {
    expect(lastExitCode('ok\n[exit code: 0]')).toBe(0)
    expect(lastExitCode('[exit code: 1]\n[exit code: 2]')).toBe(2)
    expect(lastExitCode('no marker')).toBeUndefined()
  })

  it('tool classification sets', () => {
    expect(isExecTool('bash')).toBe(true)
    expect(isExecTool('run_code')).toBe(true)
    expect(isExecTool('web_search')).toBe(false)
    expect(isWriteTool('edit')).toBe(true)
    expect(isWriteTool('web_search')).toBe(false)
    expect(isTestCommand('pnpm test')).toBe(true)
    expect(isTestCommand('ls')).toBe(false)
  })

  it('textOfBlocks joins only text blocks', () => {
    expect(textOfBlocks([{ type: 'text', text: 'a' }, { type: 'image', text: 'ignored' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
})
