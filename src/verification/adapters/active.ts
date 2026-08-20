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

import type { CriterionSpecification, EvidenceFact, SensitivityClass } from '../../domain/types.ts'
import { contentHash } from '../../domain/ids.ts'
import { resolveScopedPath } from '../paths.ts'

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
 * Infrastructure failure gate (spec §12.3): timed out / failed to start /
 * output truncated. Such outcomes mean the command never ran to completion,
 * so its output must never be parsed into pass/fail evidence — the verdict
 * is always 'unknown'. Non-zero exits are handled per-verifier: they are an
 * infrastructure failure for git-scope, but legitimate for diagnostics tools
 * (tsc/eslint exit 1 when findings exist).
 */
function infraVerdict(
  outcome: CommandOutcome,
  label: string,
  sensitivity: SensitivityClass,
  options: ActiveOptions,
  providerId: string,
): ActiveVerdict | undefined {
  if (outcome.timedOut) {
    return {
      status: 'unknown',
      fact: { kind: 'verifier', providerId, verdict: 'unknown', detail: 'verification timed out' },
      sensitivity,
      note: `${label} timed out after ${options.timeoutMs}ms`,
    }
  }
  if (outcome.exitCode === null) {
    return {
      status: 'unknown',
      fact: { kind: 'verifier', providerId, verdict: 'unknown', detail: 'command failed to start' },
      sensitivity,
      note: `${label} failed to start${outcome.errorCode === undefined ? '' : ` (${outcome.errorCode})`}`,
    }
  }
  if (outcome.truncated) {
    return {
      status: 'unknown',
      fact: { kind: 'verifier', providerId, verdict: 'unknown', detail: 'output truncated' },
      sensitivity,
      note: `${label} output was truncated at ${options.maxOutputBytes} bytes — results unreliable`,
    }
  }
  return undefined
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
      const scoped = await resolveScopedPath(options.scopeRoot, specification.path)
      if (scoped.status === 'escape') {
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
      if (scoped.status === 'ok' && scoped.realPath !== undefined) {
        try {
          const info = await stat(scoped.realPath)
          exists = info.isFile() || info.isDirectory()
          sizeBytes = info.size
          mtimeMs = info.mtimeMs
        } catch {
          exists = false
        }
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
      const scoped = await resolveScopedPath(options.scopeRoot, specification.path)
      if (scoped.status === 'escape') {
        return {
          status: 'unknown',
          fact: { kind: 'file-state', path: specification.path, exists: false },
          sensitivity: 'confidential',
          note: `path '${specification.path}' escapes the workspace scope`,
        }
      }
      let digest: string | undefined
      let exists = false
      if (scoped.status === 'ok' && scoped.realPath !== undefined) {
        try {
          digest = await digestFile(scoped.realPath)
          exists = true
        } catch (error) {
          // Read failure on a confined, existing file is infrastructure trouble.
          if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
            digest = undefined
          } else {
            return {
              status: 'unknown',
              fact: { kind: 'verifier', providerId: 'file-digest', verdict: 'unknown', detail: 'file read failed' },
              sensitivity: 'confidential',
              note: error instanceof Error ? error.message : String(error),
            }
          }
        }
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
      const scoped = await resolveScopedPath(options.scopeRoot, specification.path)
      if (scoped.status === 'escape') {
        return {
          status: 'unknown',
          fact: { kind: 'verifier', providerId: 'json-schema', verdict: 'unknown', detail: 'path escapes scope' },
          sensitivity: 'confidential',
          note: `path '${specification.path}' escapes the workspace scope`,
        }
      }
      try {
        if (scoped.status !== 'ok' || scoped.realPath === undefined) {
          return {
            status: 'unknown',
            fact: { kind: 'verifier', providerId: 'json-schema', verdict: 'unknown', detail: 'schema target missing' },
            sensitivity: 'confidential',
            note: `file '${specification.path}' is missing`,
          }
        }
        const content = JSON.parse(await readFile(scoped.realPath, 'utf8')) as unknown
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
      for (const [outcome, label] of [[head, 'git rev-parse HEAD'], [status, 'git status --porcelain']] as const) {
        const failure = infraVerdict(outcome, label, 'internal', options, 'git-scope')
        if (failure !== undefined) return failure
        if (outcome.exitCode !== 0) {
          return {
            status: 'unknown',
            fact: { kind: 'verifier', providerId: 'git-scope', verdict: 'unknown', detail: `${label} exited ${outcome.exitCode}` },
            sensitivity: 'internal',
            note: `${label} failed (exit ${outcome.exitCode}) — changed paths cannot be trusted`,
          }
        }
      }
      // Only now is the output trustworthy: git succeeded, so stderr is not
      // error text and every porcelain line is a real changed path.
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
      const label = `diagnostic command '${specification.command}'`
      // timedOut / failed to start / truncated: the command never ran to
      // completion, so its output must never be parsed.
      const gate = infraVerdict(outcome, label, 'internal', options, 'diagnostic-count')
      if (gate !== undefined && (outcome.timedOut || outcome.exitCode === null || outcome.truncated)) {
        return gate
      }
      const counts = countDiagnostics(outcome.output)
      // tsc/eslint legitimately exit non-zero when findings exist — but a
      // non-zero exit with zero parsed diagnostics is infrastructure trouble.
      if (outcome.exitCode !== 0 && counts.errors === 0 && counts.warnings === 0) {
        return {
          status: 'unknown',
          fact: { kind: 'verifier', providerId: 'diagnostic-count', verdict: 'unknown', detail: `command exited ${outcome.exitCode} without diagnostics` },
          sensitivity: 'internal',
          note: `${label} exited ${outcome.exitCode} but produced no parseable diagnostics`,
        }
      }
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
      // TAP from a command's output (framework 'tap' + command), or a report
      // file (TAP text or JUnit XML via reportPath). Never fabricates a run.
      if (specification.framework === 'junit') {
        if (specification.reportPath === undefined) {
          return {
            status: 'unknown',
            fact: { kind: 'verifier', providerId: 'junit-report', verdict: 'unknown', detail: 'junit requires reportPath' },
            sensitivity: 'internal',
            note: 'junit test-report criteria need a reportPath (workspace-relative)',
          }
        }
        const scoped = await resolveScopedPath(options.scopeRoot, specification.reportPath)
        if (scoped.status === 'escape') {
          return {
            status: 'unknown',
            fact: { kind: 'verifier', providerId: 'junit-report', verdict: 'unknown', detail: 'reportPath escapes scope' },
            sensitivity: 'internal',
            note: `reportPath '${specification.reportPath}' escapes the workspace scope`,
          }
        }
        try {
          if (scoped.status !== 'ok' || scoped.realPath === undefined) {
            return {
              status: 'unknown',
              fact: { kind: 'verifier', providerId: 'junit-report', verdict: 'unknown', detail: 'reportPath missing' },
              sensitivity: 'internal',
              note: `report file '${specification.reportPath}' is missing`,
            }
          }
          const xml = await readFile(scoped.realPath, 'utf8')
          const { parseJunit, junitSatisfies } = await import('./junit.ts')
          const counts = parseJunit(xml)
          if (counts === undefined) {
            return {
              status: 'unknown',
              fact: { kind: 'verifier', providerId: 'junit-report', verdict: 'unknown', detail: 'not a JUnit XML report' },
              sensitivity: 'internal',
              note: `'${specification.reportPath}' does not look like a JUnit report`,
            }
          }
          const ok = junitSatisfies(counts, specification.minPassed, specification.maxFailed)
          return {
            status: ok ? 'pass' : 'fail',
            fact: {
              kind: 'test-report',
              framework: 'junit',
              passed: counts.passed,
              failed: counts.failed,
              skipped: counts.skipped,
              sourceLabel: specification.reportPath,
            },
            sensitivity: 'internal',
            note: ok ? undefined : `${counts.failed} failed / ${counts.passed} passed does not satisfy ${specification.maxFailed}/${specification.minPassed}`,
          }
        } catch (error) {
          return {
            status: 'unknown',
            fact: { kind: 'verifier', providerId: 'junit-report', verdict: 'unknown', detail: 'report read failed' },
            sensitivity: 'internal',
            note: error instanceof Error ? error.message : String(error),
          }
        }
      }
      if (specification.framework === 'tap' && specification.command !== undefined) {
        const outcome = await run(specification.command)
        const failure = infraVerdict(outcome, `'${specification.command}'`, 'internal', options, 'tap-report')
        if (failure !== undefined) return failure
        const { looksLikeTap, parseTap, tapSatisfies } = await import('./tap.ts')
        // Non-zero exits are legitimate: failing suites exit non-zero AND
        // carry their counts in TAP — parse them; a non-zero exit without
        // TAP falls through to 'no parseable TAP output' → unknown.
        const counts = looksLikeTap(outcome.output) ? parseTap(outcome.output) : undefined
        if (counts === undefined) {
          return {
            status: 'unknown',
            fact: { kind: 'verifier', providerId: 'tap-report', verdict: 'unknown', detail: 'no TAP output' },
            sensitivity: 'internal',
            note: `'${specification.command}' produced no parseable TAP output`,
          }
        }
        const ok = tapSatisfies(counts, specification.minPassed, specification.maxFailed)
        return {
          status: ok ? 'pass' : 'fail',
          fact: {
            kind: 'test-report',
            framework: 'tap',
            passed: counts.passed,
            failed: counts.failed,
            skipped: counts.skipped,
            sourceLabel: specification.command,
          },
          sensitivity: 'internal',
          note: ok ? undefined : `${counts.failed} failed / ${counts.passed} passed does not satisfy ${specification.maxFailed}/${specification.minPassed}`,
        }
      }
      return {
        status: 'unknown',
        fact: { kind: 'verifier', providerId: 'test-report', verdict: 'unknown', detail: 'no active runner for this configuration' },
        sensitivity: 'internal',
        note: 'tap framework needs a command; junit needs a reportPath',
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
