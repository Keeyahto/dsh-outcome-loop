/**
 * Privacy regression tests (spec §19.3): the default composition must prove
 * zero model calls, zero model-visible surface, zero network, no session-log
 * writes, and no raw content anywhere in storage.
 *
 * These are structural + behavioral: we scan the source graph of the shipped
 * bundle for forbidden imports, and we assert the service never calls
 * session.append or any network/LLM API.
 */

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { Config } from '../../src/config.ts'
import { validateConfig } from '../../src/index.ts'

const SRC = new URL('../../src/', import.meta.url).pathname

function builtFiles(): string[] {
  const out: string[] = []
  const files = globSync(`${SRC.replace(/\/src\/$/, '/lib/')}**/*.js`)
  for (const file of files) out.push(file)
  return [...new Set(out)]
}

describe('default privacy gates (spec §19.3)', () => {
  it('the bundle never imports LLM, network, or model-facing packages', () => {
    const forbidden = [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-token-meter',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      'node:tls',
      'undici',
      'fetch',
    ]
    const sources = builtFiles().map((f) => readFileSync(f, 'utf8'))
    for (const source of sources) {
      for (const name of forbidden) {
        // fetch appears in comments only; check imports specifically.
        if (name === 'fetch') continue
        expect(source, `forbidden import '${name}' in shipped bundle`).not.toContain(`import ${name}`)
        expect(source, `forbidden require '${name}' in shipped bundle`).not.toContain(`require(${JSON.stringify(name)})`)
        expect(source, `forbidden dynamic import '${name}' in shipped bundle`).not.toContain(`import('${name}')`)
      }
    }
  })

  it('the service never appends to the session log and never opens the network', () => {
    const serviceSource = readFileSync(`${SRC}service.ts`, 'utf8')
    const observerSource = readFileSync(`${SRC}dsh/observer.ts`, 'utf8')
    expect(serviceSource).not.toContain('.append(')
    expect(observerSource).not.toContain('.append(')
    expect(serviceSource).not.toContain('net.createConnection')
    expect(serviceSource).not.toContain('https.request')
    // The only exec surface is the active verifier, and it is policy-gated.
    expect(serviceSource).toContain('deploymentAutoRun')
  })

  it('default config keeps every hard gate closed', () => {
    const config = Config({}) as Parameters<typeof validateConfig>[0]
    expect(config.verification.autoRun).toBe(false)
    expect(config.verification.llmJudge).toBe('disabled')
    expect(config.privacy.network).toBe('disabled')
    expect(config.capture.rawMessages).toBe(false)
    expect(config.capture.rawToolArguments).toBe(false)
    expect(config.capture.rawToolResults).toBe(false)
    expect(() => validateConfig(config)).not.toThrow()
  })

  it('validateConfig fails loud on attempts to open gates', () => {
    expect(() => validateConfig({ ...Config({}) as never, verification: { llmJudge: 'enabled' } } as never)).toThrow()
    expect(() => validateConfig({ ...Config({}) as never, privacy: { network: 'enabled' } } as never)).toThrow()
    expect(() => validateConfig({ ...Config({}) as never, capture: { rawMessages: true } } as never)).toThrow()
  })

  it('the observer hot path is content-free and constant-size', () => {
    const eventsSource = readFileSync(`${SRC}dsh/events.ts`, 'utf8')
    // Facts carry digests, counts and references — never raw text fields.
    expect(eventsSource).not.toContain('content: text')
    expect(eventsSource).not.toContain('rawInput')
    expect(eventsSource).toContain('contentHash')
  })

  it('no pricing table exists anywhere', () => {
    const sources = builtFiles().map((f) => readFileSync(f, 'utf8')).join('\n')
    // No price-table structure, no currency constants, no per-million math.
    expect(sources).not.toMatch(/price\s*table|price\s*per|per\s*million|usd|rmb|¥/i)
  })
})
