/**
 * DEP-02A2 follow-up (M1 restart gate, schema regression): the
 * evidence-fact `z.discriminatedUnion('kind', ...)` in
 * `src/persistence/schema.ts` had two cases where the discriminator
 * value was a bare **string** (`kind: 'verifier'`, `kind: 'decision'`)
 * instead of a `z.literal(...)`. zod v4.4.3 routes such a discriminator
 * through an internal cache that is `undefined` for that branch, which
 * throws a `TypeError: Cannot read properties of undefined (reading
 * 'values')` at parse time — and the dsh-storage-domain loader
 * translates that into `invalid-record: stored record ... does not
 * match its schema`, blocking the SECOND process boot. The fix is
 * to use `z.literal(...)` for every case in the union; this
 * regression asserts that the schema is parseable for every
 * documented `kind` value.
 */
import { describe, expect, it } from 'vitest'

import { evidenceRowSchema } from '../../src/persistence/schema.js'

describe('evidence fact schema — DEP-02A2 schema-discriminator regression', () => {
  const factsByKind: Readonly<Record<string, unknown>> = {
    'command': {
      kind: 'command',
      argvDigest: 'aade7523',
      commandLabel: 'node verify.js',
      exitCode: 0,
      durationMs: 69,
    },
    'test-report': {
      kind: 'test-report',
      framework: 'vitest',
      passed: 12,
      failed: 0,
      sourceLabel: 'unit',
    },
    'file-state': {
      kind: 'file-state',
      path: 'src/index.ts',
      exists: true,
    },
    'git-scope': {
      kind: 'git-scope',
      headDigest: 'abc',
      changedPaths: ['src/index.ts'],
      violations: [],
    },
    'diagnostic-count': {
      kind: 'diagnostic-count',
      toolLabel: 'tsc',
      errors: 0,
      warnings: 1,
    },
    'turn': {
      kind: 'turn',
      turn: 1,
      reasonKind: 'normal',
    },
    'usage': {
      kind: 'usage',
      usageKind: 'estimate',
    },
    'user-confirmation': {
      kind: 'user-confirmation',
      disposition: 'accepted',
    },
    'feedback': {
      kind: 'feedback',
      textDigest: 'fb',
      seq: 1,
    },
    'tool-outcome': {
      kind: 'tool-outcome',
      toolName: 'str-replace-editor',
      callId: 'call-1',
      isError: false,
    },
    // The two cases that used to be written as bare strings — the
    // bootstrap M1 restart boot fails on these because zod v4.4.3
    // cannot resolve the discriminator. After the fix they parse
    // exactly like the others.
    'verifier': {
      kind: 'verifier',
      providerId: 'file-digest',
      verdict: 'pass',
      detail: 'digest ok',
    },
    'decision': {
      kind: 'decision',
      source: 'gate-router',
      decisionId: 'dec-1',
      strategy: 'reuse',
    },
  }

  for (const [kind, fact] of Object.entries(factsByKind)) {
    it(`parses an evidence row with fact.kind = '${kind}' without zod internal errors`, () => {
      // Build a well-formed evidence row around the fact.
      const row = {
        schemaVersion: 1,
        id: `ole-${kind}-probe`,
        contractId: 'olc-probe',
        criterionId: 'olcr-probe',
        source: 'verifier',
        observedAt: 1_787_400_000_000,
        workspaceState: { epoch: 0 },
        fact,
        strength: 'strong',
        sensitivity: 'confidential',
        contractRevision: 1,
        verifierVersion: '0.1.0-beta.8-keeyahto.5',
      }
      const r = evidenceRowSchema.safeParse(row)
      // The old (pre-fix) schema threw a TypeError internally on the
      // 'verifier' and 'decision' cases; the test fails with
      // `r.success === false` AND with the throw being swallowed by
      // safeParse. After the fix every case parses.
      expect(r.success, JSON.stringify({ kind, issues: r.success ? null : r.error.issues })).toBe(true)
    })
  }
})
