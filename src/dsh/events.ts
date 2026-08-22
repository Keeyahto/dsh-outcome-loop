/**
 * Durable session event → domain fact normalization (spec §8.2, §13).
 *
 * The hot path is constant-size: we only extract counts, digests, exit codes
 * and references — never message bodies, tool arguments or tool output. Tool
 * call/result pairing happens here with a per-session pending-call map; the
 * map is a derived, rebuildable index (replay fills it again).
 */

import { contentHash } from '../domain/ids.ts'
import type { SessionFact } from '../domain/types.ts'
import { looksLikeTap, parseTap } from '../verification/adapters/tap.ts'

/** Event types we recognize; everything else yields a tolerated `unknown` fact. */
export const KNOWN_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'feedback/record',
  'request/context',
])

/** Tools whose arguments carry a `command` (or `code`) string we may summarize. */
const EXEC_TOOL_RE = /^(bash|sh|zsh|fish|pwsh|powershell|cmd|terminal|exec|run|run_code|run-command|run_command|shell)$/

/** Tools that deterministically mutate the workspace (freshness epoch bumps). */
export const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'create_file',
  'append_file',
  'edit',
  'edit_file',
  'apply_patch',
  'patch',
  'insert',
  'replace',
  'delete',
  'delete_file',
  'rm',
  'rmdir',
  'mkdir',
  'cp',
  'mv',
  'rename',
])

/** Test-command markers for passive test-report evidence (best effort). */
export const TEST_COMMAND_RE = /(^|\s)(test|tests|spec|specs)(\s|$)|(^|\s)(pytest|vitest|jest|mocha|go test|npm test|pnpm test|yarn test|make test|ctest)(\s|$)/

const EXIT_CODE_RE = /\[exit code:\s*(-?\d+)\]/g

export interface PendingCall {
  name: string
  turn: number
  step: number
  time: number
  commandLabel: string
}

/** Parse a raw `arguments` JSON string into a command label (privacy-safe). */
export function commandLabelOf(toolName: string, argumentsJson: string): string {
  let raw = ''
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const candidate = typeof record.command === 'string'
        ? record.command
        : typeof record.code === 'string' ? record.code : ''
      raw = candidate
    }
  } catch {
    // Not JSON (or not our schema): fall through to tool-name-only label.
  }
  const normalized = raw.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) return toolName
  // Never store the full command: keep a bounded label + digest.
  return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized
}

export function isExecTool(name: string): boolean {
  return EXEC_TOOL_RE.test(name)
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

export function isTestCommand(label: string): boolean {
  return TEST_COMMAND_RE.test(label)
}

/**
 * Extract text blocks from a tool-result message content array. A
 * ToolResultMessage wraps its blocks in a single `tool-result` block, so
 * text is read one level deep (never copied into the ledger — only counts
 * and exit codes are derived in memory).
 */
export function textOfBlocks(content: readonly { type?: string; text?: unknown; content?: unknown }[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      out += textOfBlocks(block.content as { type?: string; text?: unknown; content?: unknown }[])
    }
  }
  return out
}

/** Extract the LAST `[exit code: N]` marker from tool output text. */
export function lastExitCode(text: string): number | undefined {
  let match: RegExpExecArray | null
  let last: number | undefined
  EXIT_CODE_RE.lastIndex = 0
  while ((match = EXIT_CODE_RE.exec(text)) !== null) {
    const value = Number(match[1])
    if (Number.isInteger(value)) last = value
  }
  return last
}

export interface ExtractorState {
  /** callId → pending call info (per session). */
  pending: Map<string, PendingCall>
}

export function createExtractorState(): ExtractorState {
  return { pending: new Map() }
}

/**
 * Normalize one durable event into zero or more facts. Never throws on
 * unknown event types (spec: unknown events must not crash the plugin).
 */
export function normalizeEvent(
  event: { type: string; seq: number; time: number; data: unknown },
  state: ExtractorState,
): SessionFact[] {
  const facts: SessionFact[] = []
  const base = { seq: event.seq, time: event.time }

  switch (event.type) {
    case 'turn/start': {
      const data = event.data as { turn: number }
      facts.push({ kind: 'turn-start', ...base, turn: data.turn })
      break
    }
    case 'turn/end': {
      const data = event.data as { turn: number; reason: { kind: string } }
      facts.push({ kind: 'turn-end', ...base, turn: data.turn, reasonKind: data.reason?.kind ?? 'unknown' })
      break
    }
    case 'step/start': {
      const data = event.data as { turn: number; step: number }
      facts.push({ kind: 'step-start', ...base, turn: data.turn, step: data.step })
      break
    }
    case 'step/end': {
      const data = event.data as { turn: number; step: number }
      facts.push({ kind: 'step-end', ...base, turn: data.turn, step: data.step })
      break
    }
    case 'user/message': {
      const data = event.data as { source?: { kind?: string; form?: string; plugin?: string } }
      const source = data?.source?.kind ?? 'unknown'
      facts.push({
        kind: 'user-message',
        ...base,
        source: source === 'plugin' ? `plugin:${data.source?.form ?? 'context'}` : source,
      })
      break
    }
    case 'assistant/message': {
      const data = event.data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
      const usage = data.usage
      if (usage !== undefined) {
        facts.push({
          kind: 'usage',
          ...base,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens !== undefined && usage.outputTokens !== undefined
            ? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            : undefined,
          usageKind: 'exact',
        })
      }
      break
    }
    case 'tool/call': {
      const data = event.data as { callId: string; name: string; arguments: string; turn: number; step: number }
      const label = isExecTool(data.name) ? commandLabelOf(data.name, data.arguments) : data.name
      state.pending.set(data.callId, {
        name: data.name,
        turn: data.turn,
        step: data.step,
        time: event.time,
        commandLabel: label,
      })
      facts.push({
        kind: 'tool-call',
        ...base,
        callId: data.callId,
        name: data.name,
        argumentsDigest: contentHash(data.name, data.arguments),
      })
      break
    }
    case 'tool/result': {
      const data = event.data as {
        callId?: string
        message?: { content?: readonly { type?: string; text?: unknown }[]; source?: { callId?: string } }
        error?: { name?: string; code?: string }
        meta?: unknown
      }
      const callId = data.callId ?? data.message?.source?.callId ?? ''
      const pending = state.pending.get(callId)
      state.pending.delete(callId)
      const name = pending?.name ?? 'unknown-tool'
      const text = textOfBlocks(data.message?.content ?? [])
      const exitCode = pending !== undefined && isExecTool(name) ? lastExitCode(text) : undefined
      const isError = Boolean(data.error) || (data.message?.content?.some((b) => b.type === 'tool-result' && (b as { isError?: boolean }).isError === true) ?? false)
      const durationMs = pending !== undefined ? Math.max(0, event.time - pending.time) : undefined
      facts.push({
        kind: 'tool-result',
        ...base,
        callId,
        name,
        isError,
        errorCode: data.error?.code,
        durationMs,
        outputBytes: text.length,
        exitCode,
        ...(pending !== undefined && pending.commandLabel !== name ? { commandLabel: pending.commandLabel } : {}),
      })
      // Workspace-epoch bump: explicit write tools + exec tools that
      // may mutate the workspace (shell scripts, `run_code`, etc.).
      //
      // Why both groups: explicit writes obviously mutate. Exec tools
      // (`run_code`, `bash`, `sh`, …) carry an opaque shell script
      // whose workspace effects we cannot observe passively — we
      // must treat them as MAY-mutate and invalidate stale evidence.
      // This is conservative (cat/ls also bump), but it is the
      // fail-closed direction: a missing bump would freeze stale
      // evidence as fresh and lock the verifier in INCONCLUSIVE
      // (engine.ts:240-243 `passRows && failRows` conflict) forever.
      //
      // The `!isError` guard is dropped for BOTH groups on purpose:
      // a failed exec tool may have left a half-written state (file
      // created before the failing line), and we cannot observe
      // that from the result alone. Bumping on failure is the
      // conservative choice — a failed write tool also bumps
      // because we cannot tell whether partial state was written.
      // The pre-fix behavior kept `!isError` for `isWriteTool`, which
      // left an asymmetry between write and exec tools.
      if (isWriteTool(name) || isExecTool(name)) {
        facts.push({ kind: 'file-change-marker', ...base, toolName: name })
      }
      // Structured TAP extraction for test commands: parse in memory, store
      // only counts (hot path stays constant-size on the ledger).
      const label = pending?.commandLabel ?? name
      if (isTestCommand(label) && text.length > 0 && looksLikeTap(text)) {
        const counts = parseTap(text)
        if (counts !== undefined) {
          facts.push({
            kind: 'test-report',
            ...base,
            framework: 'tap',
            passed: counts.passed,
            failed: counts.failed,
            skipped: counts.skipped,
            sourceLabel: label,
          })
        }
      }
      break
    }
    case 'feedback/record': {
      const data = event.data as { text?: string }
      facts.push({ kind: 'feedback', ...base, textDigest: contentHash(data.text ?? '') })
      break
    }
    case 'request/context': {
      const data = event.data as { provider?: string; model?: string }
      if (typeof data.provider === 'string' && typeof data.model === 'string') {
        facts.push({ kind: 'route', ...base, provider: data.provider, model: data.model })
      }
      break
    }
    default:
      facts.push({ kind: 'unknown', ...base, type: event.type })
  }
  return facts
}
