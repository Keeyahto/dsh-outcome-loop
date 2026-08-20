/**
 * Workspace-confined path resolution (spec §14.3, §19.1).
 *
 * Lexical containment alone is not a security boundary: a path whose
 * components traverse symlinks can escape the workspace while still
 * resolving lexically inside it. Every user- or contract-supplied path
 * must therefore be checked against realpath before it is read or written:
 *
 * - existing targets (reads, deletion): realpath(target) must stay inside
 *   realpath(scopeRoot);
 * - new targets (writes): the nearest existing ancestor's realpath must stay
 *   inside realpath(scopeRoot) — the file itself may not exist yet.
 *
 * An 'escape' result is an infrastructure/policy problem, never acceptance
 * evidence: callers must surface it as 'unknown', never pass/fail.
 */

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export type ScopedPathStatus = 'ok' | 'absent' | 'escape'

export interface ScopedPath {
  status: ScopedPathStatus
  /** Lexically resolved path inside the scope root (absent when 'escape'). */
  path?: string
  /** realpath of the resolved target ('ok' results only). */
  realPath?: string
}

const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR'])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Pure lexical containment (rejects absolute input and `..` escapes). */
function lexicallyScoped(scopeRoot: string, path: string): string | undefined {
  if (!isAbsolute(scopeRoot)) return undefined
  const resolved = resolve(scopeRoot, path)
  const rel = relative(scopeRoot, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  return resolved
}

/** realpath containment test — the actual security boundary. */
function contained(scopeRootReal: string, targetReal: string): boolean {
  const rel = relative(scopeRootReal, targetReal)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

async function scopeRootReal(scopeRoot: string): Promise<string | undefined> {
  try {
    return await realpath(scopeRoot)
  } catch {
    // Unresolvable workspace root: nothing can be confined to it.
    return undefined
  }
}

function escapeResult(): ScopedPath {
  return { status: 'escape' }
}

/**
 * Confine an existing target (reads, deletion, existence checks).
 * 'absent' means the whole target is missing — safe for existence checks;
 * reading is impossible, so nothing can leak.
 */
export async function resolveScopedPath(scopeRoot: string, path: string): Promise<ScopedPath> {
  const target = lexicallyScoped(scopeRoot, path)
  if (target === undefined) return escapeResult()
  const root = await scopeRootReal(scopeRoot)
  if (root === undefined) return escapeResult()
  try {
    const real = await realpath(target)
    if (!contained(root, real)) return escapeResult()
    return { status: 'ok', path: target, realPath: real }
  } catch (error) {
    const code = errorCode(error)
    if (code !== undefined && NOT_FOUND_CODES.has(code)) return { status: 'absent', path: target }
    return escapeResult()
  }
}

/**
 * Confine a target that may not exist yet (writes, directory creation):
 * walks up to the nearest existing ancestor and requires its realpath to
 * stay inside the workspace, so no write can land outside through a
 * symlinked parent or a symlink replacing the target itself.
 */
export async function confineWriteTarget(scopeRoot: string, path: string): Promise<ScopedPath> {
  const target = lexicallyScoped(scopeRoot, path)
  if (target === undefined) return escapeResult()
  const root = await scopeRootReal(scopeRoot)
  if (root === undefined) return escapeResult()
  let ancestor: string = target
  for (;;) {
    try {
      const real = await realpath(ancestor)
      if (!contained(root, real)) return escapeResult()
      return { status: 'ok', path: target, realPath: real }
    } catch (error) {
      const code = errorCode(error)
      if (code !== undefined && NOT_FOUND_CODES.has(code)) {
        const parent = dirname(ancestor)
        if (parent === ancestor) return escapeResult()
        ancestor = parent
        continue
      }
      return escapeResult()
    }
  }
}
