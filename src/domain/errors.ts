/**
 * Stable failure taxonomy (spec §7.5) and result envelope.
 *
 * Infrastructure failures (storage, version mismatch, disposal) reject the
 * call; business failures return a discriminated OutcomeError. Infrastructure
 * errors must never masquerade as "task failed"; user cancellation must never
 * be counted as a verifier failure; missing evidence must never be counted as
 * a criterion fail.
 */

import type { JsonValue } from './types.ts'

export type OutcomeErrorCode =
  | 'criterion-failed'
  | 'evidence-missing'
  | 'evidence-stale'
  | 'evidence-conflict'
  | 'verification-command-failed'
  | 'verification-timeout'
  | 'verification-output-limit'
  | 'policy-denied'
  | 'permission-denied'
  | 'tool-error'
  | 'model-error'
  | 'max-tokens'
  | 'turn-aborted'
  | 'task-blocked'
  | 'storage-error'
  | 'schema-version-unsupported'
  | 'dsh-version-unsupported'
  | 'plugin-disposed'
  | 'contract-not-found'
  | 'contract-revision-conflict'
  | 'criterion-not-found'
  | 'invalid-input'
  | 'export-approval-invalid'
  | 'unknown'

export interface OutcomeError {
  readonly code: OutcomeErrorCode
  readonly message: string
  readonly details?: JsonValue
}

export type OutcomeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OutcomeError }

export function ok<T>(value: T): OutcomeResult<T> {
  return { ok: true, value }
}

export function err<T = never>(code: OutcomeErrorCode, message: string, details?: JsonValue): OutcomeResult<T> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

export function isOutcomeError(value: unknown): value is OutcomeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value
}

/**
 * Convert any thrown value into an OutcomeError. Storage/IO failures map to
 * `storage-error`; everything unknown stays `unknown` — never a business code.
 */
export function infrastructureError(cause: unknown, context: string): OutcomeError {
  const message = cause instanceof Error ? cause.message : String(cause)
  return { code: 'storage-error', message: `${context}: ${message}` }
}
