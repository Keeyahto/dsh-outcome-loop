/**
 * Active verification (spec §12.3): deterministic, sandboxed-by-default
 * command/file/git checks. NEVER runs by default — the policy layer gates
 * every invocation. Commands are spawned argv-first (no shell string
 * evaluation), with cwd confined to the contract scope, an allowlisted env,
 * timeout, output cap and AbortSignal.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { stat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { CriterionSpecification, EvidenceFact, SensitivityClass } from '../../domain/types.ts'
import { contentHash } from '../../domain/ids.ts'

export interface ActiveOptions {
  /** Resolved cwd; must be inside scopeRoot (checked by the caller). */
  cwd: string
  scopeRoot: string
  timeoutMs: number
  maxOutputBytes: number
  /** Env allowlist — never the full process env (no DSH secrets). */
  env: Readonly<Record<string, string>>
  signal?: AbortSignal
}

export interface CommandOutcome {
  exitCode: number | null
  output: string
  truncated: boolean
  timedOut: boolean
  errorCode?: string
}

/** Minimal POSIX-ish tokenizer: splits on whitespace, honors quotes. */
export function splitArgs(line: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/** Run one command with argv + cwd (never a shell string). */
export function runCommand(argv: readonly string[], options: ActiveOptions): Promise<CommandOutcome> {
  if (argv.length === 0) {
    return Promise.resolve({ exitCode: null, output: '', truncated: false, timedOut: false, errorCode: 'invalid-input' })
  }
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      signal: options.signal,
    })
    let output = ''
    let truncated = false
    const append = (chunk: Buffer | string) => {
      if (truncated) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (output.length + text.length > options.maxOutputBytes) {
        output += text.slice(0, Math.max(0, options.maxOutputBytes - output.length))
        truncated = true
      } else {
        output += text
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      const raw = error as unknown
      const errorCode = typeof raw === 'object' && raw !== null && typeof (raw as { code?: unknown }).code === 'string'
        ? (raw as { code: string }).code
        : 'spawn-error'
      resolvePromise({ exitCode: null, output, truncated, timedOut, errorCode })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, output, truncated, timedOut })
    })
  })
}

/** sha256 digest of a file. */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const content = await readFile(path)
  hash.update(content)
  return hash.digest('hex')
}

/** Resolve and confine a workspace-relative path inside the scope root. */
export function resolveScopedPath(scopeRoot: string, path: string): string | undefined {
  if (!isAbsolute(scopeRoot)) return undefined
  const resolved = resolve(scopeRoot, path)
  const rel = relative(scopeRoot, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  return resolved
}

/** Parse `git status --porcelain` lines into changed paths (relative). */
export function parsePorcelain(output: string): string[] {
  const paths: string[] = []
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue
    // Keep the leading status columns intact: trim() would destroy them.
    const trimmed = line.replace(/\s+$/, '')
    // XY PATH or XY -> PATH (renames). Skip status codes, keep the path.
    const body = trimmed.length > 3 ? trimmed.slice(3) : trimmed
    const arrow = body.indexOf(' -> ')
    const path = arrow >= 0 ? body.slice(arrow + 4) : body
    if (path.length > 0) paths.push(path)
  }
  return paths
}

interface AjvLike {
  validate(schema: unknown, data: unknown): boolean
  errors?: readonly { message?: string }[] | null
}
type AjvCtor = new (options: { strict?: boolean; allErrors?: boolean }) => AjvLike

let ajvCtorPromise: Promise<AjvCtor> | undefined
async function ajvCtor(): Promise<AjvCtor> {
  ajvCtorPromise ??= (import('ajv') as Promise<unknown>).then((mod) => {
    const candidate = (mod as { default?: unknown }).default
    if (typeof candidate !== 'function') {
      throw new Error('outcome-loop: ajv could not be loaded (json-schema verification unavailable)')
    }
    return candidate as AjvCtor
  })
  return ajvCtorPromise
}

/** Count diagnostics from common summary formats + error/warning lines. */
export function countDiagnostics(output: string): { errors: number; warnings: number } {
  const summary = (re: RegExp): number => {
    const match = output.match(re)
    return match !== null && match[1] !== undefined ? Number(match[1]) : 0
  }
  // Summary forms: "Found N errors", "N errors" at end of line.
  let errors = Math.max(
    summary(/Found\s+(\d+)\s+errors?/i),
    summary(/(\d+)\s+errors?\s*$/m),
  )
  let warnings = Math.max(
    summary(/Found\s+(\d+)\s+warnings?/i),
    summary(/(\d+)\s+warnings?\s*$/m),
  )
  // Diagnostic lines (tsc/eslint style): one finding per line.
  let lineErrors = 0
  let lineWarnings = 0
  for (const line of output.split('\n')) {
    if (/\berror\b/i.test(line)) lineErrors += 1
    else if (/\bwarning\b/i.test(line)) lineWarnings += 1
  }
  errors = Math.max(errors, lineErrors)
  warnings = Math.max(warnings, lineWarnings)
  return { errors, warnings }
}

export interface ActiveVerdict {
  status: 'pass' | 'fail' | 'unknown'
  fact: EvidenceFact
  sensitivity: SensitivityClass
  note?: string
}

/**
 * Run one active verification. The caller (policy/engine) has already decided
 * this is allowed. Each check is read-only; none touches the network.
 */
export async function verifyActive(
  specification: CriterionSpecification,
  options: ActiveOptions,
): Promise<ActiveVerdict> {
  const run = (command: string) => runCommand(splitArgs(command), options)

  switch (specification.kind) {
    case 'command-exit': {
      const outcome = await run(specification.command)
      if (outcome.timedOut) {
        return {
          status: 'unknown',
          fact: { kind: 'command', argvDigest: contentHash(specification.command), commandLabel: specification.command, exitCode: -1, errorCode: 'verification-timeout' },
          sensitivity: 'confidential',
          note: `verification timed out after ${options.timeoutMs}ms`,
        }
      }
      if (outcome.exitCode === null) {
        return {
          status: 'unknown',
          fact: { kind: 'command', argvDigest: contentHash(specification.command), commandLabel: specification.command, exitCode: -1, errorCode: outcome.errorCode },
          sensitivity: 'confidential',
          note: 'verification command failed to start',
        }
      }
      return {
        status: outcome.exitCode === specification.expectExitCode ? 'pass' : 'fail',
        fact: {
          kind: 'command',
          argvDigest: contentHash(specification.command),
          commandLabel: specification.command,
          exitCode: outcome.exitCode,
          outputBytes: outcome.output.length,
          outputTruncated: outcome.truncated,
        },
        sensitivity: 'confidential',
        note: outcome.exitCode === specification.expectExitCode ? undefined : `exit code ${outcome.exitCode} ≠ ${specification.expectExitCode}`,
      }
    }
    case 'file-exists':
    case 'file-absent': {
      const target = resolveScopedPath(options.scopeRoot, specification.path)
      if (target === undefined) {
        return {
          status: 'unknown',
          fact: { kind: 'file-state', path: specification.path, exists: false },
          sensitivity: 'confidential',
          note: `path '${specification.path}' escapes the workspace scope`,
        }
      }
      let exists = false
      let sizeBytes: number | undefined
      let mtimeMs: number | undefined
      try {
        const info = await stat(target)
        exists = info.isFile() || info.isDirectory()
        sizeBytes = info.size
        mtimeMs = info.mtimeMs
      } catch {
        exists = false
      }
      const want = specification.kind === 'file-exists'
      return {
        status: exists === want ? 'pass' : 'fail',
        fact: { kind: 'file-state', path: specification.path, exists, sizeBytes, mtimeMs },
        sensitivity: 'confidential',
        note: exists === want ? undefined : `file ${exists ? 'exists' : 'absent'} but criterion expects ${want ? 'exists' : 'absent'}`,
      }
    }
    case 'file-digest': {
      const target = resolveScopedPath(options.scopeRoot, specification.path)
      if (target === undefined) {
        return {
          status: 'unknown',
          fact: { kind: 'file-state', path: specification.path, exists: false },
          sensitivity: 'confidential',
          note: `path '${specification.path}' escapes the workspace scope`,
        }
      }
      let digest: string | undefined
      let exists = false
      try {
        digest = await digestFile(target)
        exists = true
      } catch {
        digest = undefined
      }
      if (digest === undefined) {
        return { status: 'fail', fact: { kind: 'file-state', path: specification.path, exists: false }, sensitivity: 'confidential', note: 'file missing' }
      }
      return {
        status: digest === specification.digest ? 'pass' : 'fail',
        fact: { kind: 'file-state', path: specification.path, exists, digest },
        sensitivity: 'confidential',
        note: digest === specification.digest ? undefined : 'digest mismatch',
      }
    }
    case 'json-schema': {
      const target = resolveScopedPath(options.scopeRoot, specification.path)
      if (target === undefined) {
        return {
          status: 'unknown',
          fact: { kind: 'verifier', providerId: 'json-schema', verdict: 'unknown', detail: 'path escapes scope' },
          sensitivity: 'confidential',
          note: `path '${specification.path}' escapes the workspace scope`,
        }
      }
      try {
        const content = JSON.parse(await readFile(target, 'utf8')) as unknown
        const ajv = new (await ajvCtor())({ strict: false, allErrors: false })
        const valid = ajv.validate(specification.schema, content)
        return {
          status: valid ? 'pass' : 'fail',
          fact: { kind: 'verifier', providerId: 'json-schema', verdict: valid ? 'pass' : 'fail', detail: valid ? 'schema valid' : `schema invalid: ${String(ajv.errors?.[0]?.message ?? 'unknown error')}` },
          sensitivity: 'confidential',
        }
      } catch (error) {
        return {
          status: 'unknown',
          fact: { kind: 'verifier', providerId: 'json-schema', verdict: 'unknown', detail: 'schema check failed' },
          sensitivity: 'confidential',
          note: error instanceof Error ? error.message : String(error),
        }
      }
    }
    case 'git-scope': {
      const head = await run('git rev-parse HEAD')
      const status = await run('git status --porcelain')
      const changed = parsePorcelain(status.output)
      const forbidden = specification.forbiddenPrefixes.filter((prefix) => changed.some((p) => p.startsWith(prefix)))
      const allowed = specification.allowedPrefixes
      const outside = allowed.length > 0 ? changed.filter((p) => !allowed.some((prefix) => p.startsWith(prefix))) : []
      const violations = [...forbidden, ...outside]
      return {
        status: violations.length === 0 ? 'pass' : 'fail',
        fact: {
          kind: 'git-scope',
          headDigest: head.exitCode === 0 && head.output.trim().length > 0 ? contentHash(head.output.trim()) : undefined,
          changedPaths: changed.slice(0, 200),
          violations: violations.slice(0, 50),
        },
        sensitivity: 'internal',
        note: violations.length === 0 ? undefined : `changes outside scope: ${violations.slice(0, 5).join(', ')}`,
      }
    }
    case 'diagnostic-count': {
      const outcome = await run(specification.command)
      const counts = countDiagnostics(outcome.output)
      return {
        status: counts.errors <= specification.maxErrors && counts.warnings <= specification.maxWarnings ? 'pass' : 'fail',
        fact: { kind: 'diagnostic-count', toolLabel: specification.command, errors: counts.errors, warnings: counts.warnings },
        sensitivity: 'internal',
        note: counts.errors > specification.maxErrors || counts.warnings > specification.maxWarnings
          ? `${counts.errors} errors / ${counts.warnings} warnings exceeds ${specification.maxErrors}/${specification.maxWarnings}`
          : undefined,
      }
    }
    case 'test-report': {
      // Framework-specific report parsing is a future verifier provider;
      // active verification never fabricates a test run.
      return {
        status: 'unknown',
        fact: { kind: 'verifier', providerId: 'test-report', verdict: 'unknown', detail: 'no active runner for this framework' },
        sensitivity: 'internal',
        note: 'use a command-exit criterion with your concrete test command',
      }
    }
    case 'manual':
    case 'custom':
      return {
        status: 'unknown',
        fact: { kind: 'verifier', providerId: specification.kind, verdict: 'unknown', detail: 'not actively verifiable' },
        sensitivity: 'internal',
        note: 'manual and custom criteria are not actively verifiable',
      }
  }
}
