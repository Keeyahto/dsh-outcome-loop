/**
 * Passive verification (spec §12.2): extract facts from already-observed
 * session events. When the facts are insufficient, the answer is `unknown` —
 * the plugin never re-runs commands to obtain a label.
 */

import type { AcceptanceCriterion, Evidence, EvidenceFact, SessionFact, SessionFactLog } from '../../domain/types.ts'
import { isTestCommand } from '../../dsh/events.ts'

export interface PassiveVerdict {
  status: 'pass' | 'fail' | 'unknown'
  facts: EvidenceFact[]
  conflict: boolean
  note?: string
}

function unknown(note: string): PassiveVerdict {
  return { status: 'unknown', facts: [], conflict: false, note }
}

/** Normalize a command string for passive matching (trim + collapse spaces). */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function commandMatches(label: string | undefined, want: string): boolean {
  if (label === undefined) return false
  const normalized = normalizeCommand(label)
  const target = normalizeCommand(want)
  if (normalized === target) return true
  // Observed label may be truncated at 200 chars or carry a leading qualifier.
  return normalized.startsWith(target) && normalized.length >= target.length
}

function commandFacts(log: SessionFactLog): readonly (SessionFact & { kind: 'tool-result' })[] {
  const out: (SessionFact & { kind: 'tool-result' })[] = []
  for (const fact of log.facts) {
    if (fact.kind === 'tool-result' && fact.exitCode !== undefined) out.push(fact)
  }
  return out
}

function latestOf<T>(facts: readonly T[], key: (t: T) => number): T | undefined {
  let latest: T | undefined
  for (const fact of facts) {
    if (latest === undefined || key(fact) > key(latest)) latest = fact
  }
  return latest
}

/** Facts of one kind carried by prior evidence rows, with their capture time. */
function priorFacts<K extends EvidenceFact['kind']>(
  prior: readonly Evidence[],
  kind: K,
): { fact: EvidenceFact & { kind: K }; observedAt: number }[] {
  const out: { fact: EvidenceFact & { kind: K }; observedAt: number }[] = []
  for (const row of prior) {
    if (row.fact.kind === kind) out.push({ fact: row.fact as EvidenceFact & { kind: K }, observedAt: row.observedAt })
  }
  return out
}

/**
 * Passive verdict for one criterion against the session fact log and prior
 * evidence rows (spec §12.2). Insufficient facts ⇒ `unknown`, never a rerun.
 */
export function verifyPassive(
  criterion: AcceptanceCriterion,
  log: SessionFactLog | undefined,
  prior: readonly Evidence[],
): PassiveVerdict {
  if (log === undefined) {
    return unknown('no session facts observed — nothing to verify passively')
  }
  switch (criterion.specification.kind) {
    case 'command-exit': {
      const spec = criterion.specification
      const matches = commandFacts(log).filter((f) => commandMatches(f.commandLabel, spec.command))
      const latest = latestOf(matches, (f) => f.seq)
      if (latest === undefined) {
        return unknown(`no observed command matched '${spec.command}'`)
      }
      const fact: EvidenceFact = {
        kind: 'command',
        argvDigest: latest.callId,
        commandLabel: latest.commandLabel ?? latest.name,
        exitCode: latest.exitCode as number,
        durationMs: latest.durationMs,
        outputBytes: latest.outputBytes,
        errorCode: latest.errorCode,
      }
      return latest.exitCode === spec.expectExitCode
        ? { status: 'pass', facts: [fact], conflict: false }
        : {
            status: 'fail',
            facts: [fact],
            conflict: false,
            note: `exit code ${String(latest.exitCode)} ≠ expected ${String(spec.expectExitCode)}`,
          }
    }
    case 'test-report': {
      const spec = criterion.specification
      // 1) Structured counts win: TAP facts extracted at normalization time.
      const structured = log.facts.filter((f): f is SessionFact & { kind: 'test-report' } => f.kind === 'test-report')
        .filter((f) => spec.framework === 'any' || f.framework === spec.framework)
      const structuredLatest = latestOf(structured, (f) => f.seq)
      if (structuredLatest !== undefined) {
        const fact: EvidenceFact = {
          kind: 'test-report',
          framework: structuredLatest.framework,
          passed: structuredLatest.passed,
          failed: structuredLatest.failed,
          skipped: structuredLatest.skipped,
          sourceLabel: structuredLatest.sourceLabel,
        }
        const ok = structuredLatest.failed <= spec.maxFailed && structuredLatest.passed >= spec.minPassed
        return ok
          ? { status: 'pass', facts: [fact], conflict: false }
          : { status: 'fail', facts: [fact], conflict: false, note: `${structuredLatest.failed} failed / ${structuredLatest.passed} passed does not satisfy ${spec.maxFailed}/${spec.minPassed}` }
      }
      // 2) Fallback: a test command that exited 0/1 (exit-code proxy).
      const testRuns = commandFacts(log).filter((f) => isTestCommand(f.commandLabel ?? f.name))
      const latest = latestOf(testRuns, (f) => f.seq)
      if (latest === undefined) {
        return unknown('no test command observed (e.g. `pnpm test`)')
      }
      const fact: EvidenceFact = {
        kind: 'test-report',
        framework: spec.framework,
        passed: latest.exitCode === 0 ? 1 : 0,
        failed: latest.exitCode === 0 ? 0 : 1,
        sourceLabel: latest.commandLabel ?? latest.name,
      }
      if (latest.exitCode === 0) {
        return {
          status: 'pass',
          facts: [fact],
          conflict: false,
          note: spec.framework === 'any' ? undefined : `structured ${spec.framework} counts are only available with active verification`,
        }
      }
      return { status: 'fail', facts: [fact], conflict: false, note: 'test command exited non-zero' }
    }
    case 'file-exists':
    case 'file-absent': {
      const spec = criterion.specification
      const observed = priorFacts(prior, 'file-state').filter((f) => f.fact.path === spec.path)
      const latest = latestOf(observed, (f) => f.observedAt)
      if (latest === undefined) {
        return unknown(`no file-state evidence for '${spec.path}' (requires active verification or import)`)
      }
      const want = criterion.specification.kind === 'file-exists'
      return latest.fact.exists === want
        ? { status: 'pass', facts: [latest.fact], conflict: false }
        : { status: 'fail', facts: [latest.fact], conflict: false, note: `file ${latest.fact.exists ? 'exists' : 'absent'} but criterion expects ${want ? 'exists' : 'absent'}` }
    }
    case 'file-digest': {
      const spec = criterion.specification
      const observed = priorFacts(prior, 'file-state').filter((f) => f.fact.path === spec.path && f.fact.digest !== undefined)
      const latest = latestOf(observed, (f) => f.observedAt)
      if (latest === undefined) {
        return unknown(`no digest evidence for '${spec.path}'`)
      }
      return latest.fact.digest === spec.digest
        ? { status: 'pass', facts: [latest.fact], conflict: false }
        : { status: 'fail', facts: [latest.fact], conflict: false, note: 'digest mismatch' }
    }
    case 'json-schema': {
      return unknown('json-schema verification requires active verification or a registered provider')
    }
    case 'git-scope': {
      const spec = criterion.specification
      const facts = priorFacts(prior, 'git-scope')
      const latest = latestOf(facts, (f) => f.observedAt)
      if (latest === undefined) {
        return unknown('no git-scope evidence (requires active verification or import)')
      }
      const violations = latest.fact.violations.length > 0
        ? latest.fact.violations
        : spec.forbiddenPrefixes.filter((prefix) => latest.fact.changedPaths.some((p) => p.startsWith(prefix)))
      return violations.length === 0
        ? { status: 'pass', facts: [latest.fact], conflict: false }
        : { status: 'fail', facts: [latest.fact], conflict: false, note: `changes outside scope: ${violations.slice(0, 5).join(', ')}` }
    }
    case 'diagnostic-count': {
      const spec = criterion.specification
      const facts = priorFacts(prior, 'diagnostic-count')
      const latest = latestOf(facts, (f) => f.observedAt)
      if (latest === undefined) {
        return unknown(`no diagnostic-count evidence for '${spec.command}'`)
      }
      if (latest.fact.errors > spec.maxErrors || latest.fact.warnings > spec.maxWarnings) {
        return {
          status: 'fail',
          facts: [latest.fact],
          conflict: false,
          note: `${latest.fact.errors} errors / ${latest.fact.warnings} warnings exceeds ${spec.maxErrors}/${spec.maxWarnings}`,
        }
      }
      return { status: 'pass', facts: [latest.fact], conflict: false }
    }
    case 'manual': {
      return unknown('manual criteria require an explicit user disposition (accept/reject)')
    }
    case 'custom': {
      return unknown(`custom criterion '${criterion.specification.providerId}' is handled by the engine, not the passive adapter`)
    }
  }
}
