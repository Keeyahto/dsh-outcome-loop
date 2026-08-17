/**
 * Deterministic redaction and sensitivity classification (spec §14.2, §14.5).
 *
 * Redaction is applied before anything crosses the export boundary. Secrets
 * never appear in preview bodies — only hit type and position counts.
 * Redaction is deterministic: same input, same output, so preview digests are
 * stable and diff-able.
 */

import type { EvidenceFact, SensitivityClass } from '../domain/types.ts'

export const REDACTION_VERSION = 'outcome-loop.redact.v1'

export interface RedactOptions {
  redactSecrets: boolean
  redactPersonalData: boolean
  /** Absolute home path to neutralize in outputs (default: never known). */
  homePath?: string
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/authorization\s*[:=]\s*["']?[^\s"',;]+/gi, 'authorization: [REDACTED]'],
  [/(api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]+/gi, '$1: [REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED TOKEN]'],
]

const PERSONAL_PATTERNS: readonly [RegExp, string][] = [
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, '[REDACTED EMAIL]'],
  [/\b1[3-9]\d{9}\b/g, '[REDACTED PHONE]'],
  [/\b\d{17}[\dXx]\b/g, '[REDACTED ID]'],
]

/** Replace secrets/personal data; returns { text, changes }. */
export function redactText(text: string, options: RedactOptions): { text: string; changes: number } {
  let output = text
  let changes = 0
  if (options.homePath !== undefined && options.homePath.length > 1) {
    const before = output
    output = output.split(options.homePath).join('~')
    changes += before.length !== output.length ? 1 : 0
  }
  const apply = (patterns: readonly [RegExp, string][]) => {
    for (const [pattern, replacement] of patterns) {
      const before = output
      output = output.replace(pattern, replacement)
      if (output !== before) changes += 1
    }
  }
  if (options.redactSecrets) apply(SECRET_PATTERNS)
  if (options.redactPersonalData) apply(PERSONAL_PATTERNS)
  return { text: output, changes }
}

/** Classify a text; unknown content is conservatively sensitive. */
export function classifyText(text: string): { sensitivity: SensitivityClass; hits: Partial<Record<SensitivityClass, number>> } {
  const hits: Partial<Record<SensitivityClass, number>> = {}
  let secret = 0
  let personal = 0
  for (const [pattern] of SECRET_PATTERNS) {
    secret += (text.match(pattern) ?? []).length
  }
  for (const [pattern] of PERSONAL_PATTERNS) {
    personal += (text.match(pattern) ?? []).length
  }
  if (secret > 0) {
    hits.secret = secret
    return { sensitivity: 'secret', hits }
  }
  if (personal > 0) {
    hits['personal-data'] = personal
    return { sensitivity: 'personal-data', hits }
  }
  if (text.includes('/') || text.length > 80) {
    hits.confidential = 1
    return { sensitivity: 'confidential', hits }
  }
  return { sensitivity: 'public', hits }
}

/** Classify one evidence fact (defaults: unknown → sensitive). */
export function classifyFact(fact: EvidenceFact): SensitivityClass {
  switch (fact.kind) {
    case 'command':
    case 'file-state':
      return 'confidential'
    case 'user-confirmation':
      return 'personal-data'
    case 'turn':
    case 'usage':
      return 'public'
    case 'test-report':
    case 'git-scope':
    case 'diagnostic-count':
    case 'feedback':
    case 'tool-outcome':
    case 'verifier':
      return 'internal'
  }
}
