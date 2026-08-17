/**
 * TAP (Test Anything Protocol) parser — deterministic, dependency-free.
 *
 * Parses TAP v12/v13 output into structured counts. Only counts leave the
 * parser; raw output never enters the ledger. When the output is not TAP,
 * returns undefined and callers fall back to exit-code evidence.
 */

export interface TapCounts {
  passed: number
  failed: number
  skipped: number
  /** Planned total from `1..N`, when present. */
  planned?: number
}

/** True when the text looks like a TAP stream (version or plan header). */
export function looksLikeTap(text: string): boolean {
  const firstLines = text.slice(0, 4096).split('\n')
  for (const line of firstLines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('TAP version ')) return true
    if (/^\d+\.\.\d+/.test(trimmed)) return true
  }
  return false
}

/** Parse a TAP stream into counts; undefined when not parseable. */
export function parseTap(text: string): TapCounts | undefined {
  if (!looksLikeTap(text)) return undefined
  let passed = 0
  let failed = 0
  let skipped = 0
  let planned: number | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const plan = /^(\d+)\.\.(\d+)/.exec(line)
    if (plan !== null) {
      planned = Number(plan[2])
      continue
    }
    const result = /^(ok|not ok)\b/.exec(line)
    if (result === null) continue
    const isOk = result[1] === 'ok'
    if (line.includes('# SKIP')) {
      skipped += 1
      continue
    }
    if (isOk) passed += 1
    else failed += 1
  }
  if (passed === 0 && failed === 0 && skipped === 0 && planned === undefined) {
    return undefined
  }
  return { passed, failed, skipped, ...(planned === undefined ? {} : { planned }) }
}

/** Whether observed counts satisfy the criterion thresholds. */
export function tapSatisfies(counts: TapCounts, minPassed: number, maxFailed: number): boolean {
  return counts.failed <= maxFailed && counts.passed >= minPassed
}
