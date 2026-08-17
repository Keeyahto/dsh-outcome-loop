/**
 * JUnit XML report parser — deterministic, dependency-free.
 *
 * Parses the common JUnit XML shapes (`<testsuites>`/`<testsuite>` with
 * `<testcase>` children carrying `<failure>`, `<error>` and `<skipped>`).
 * Handles self-closing tags, quoted attributes and CDATA-free text bodies.
 * Only counts leave the parser; the XML text never enters the ledger.
 */

export interface JunitCounts {
  passed: number
  failed: number
  skipped: number
  tests: number
}

/** True when the text plausibly is a JUnit XML report. */
export function looksLikeJunit(text: string): boolean {
  return /<testsuites?\b/i.test(text.slice(0, 4096))
}

/** Parse a JUnit XML string into counts; undefined when not parseable. */
export function parseJunit(xml: string): JunitCounts | undefined {
  if (!looksLikeJunit(xml)) return undefined
  let testcases = 0
  let failures = 0
  let errors = 0
  let skipped = 0
  // Match full <testcase ...>...</testcase> or self-closing variants.
  const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  let match: RegExpExecArray | null
  while ((match = testcaseRe.exec(xml)) !== null) {
    testcases += 1
    const body = match[2] ?? ''
    if (/<skipped\b/i.test(body)) skipped += 1
    if (/<failure\b/i.test(body)) failures += 1
    if (/<error\b/i.test(body)) errors += 1
  }
  if (testcases === 0) return undefined
  return {
    passed: testcases - failures - errors - skipped,
    failed: failures + errors,
    skipped,
    tests: testcases,
  }
}

/** Whether observed counts satisfy the criterion thresholds. */
export function junitSatisfies(counts: JunitCounts, minPassed: number, maxFailed: number): boolean {
  return counts.failed <= maxFailed && counts.passed >= minPassed
}
