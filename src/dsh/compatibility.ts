/**
 * DSH compatibility boundary (spec §3, §8.1): fail loud and early when the
 * running DSH does not provide the public capabilities this plugin relies on.
 * The plugin never deep-imports DSH internals and never guesses API shapes
 * from object appearance alone.
 */

export const KNOWN_COMPATIBLE_DSH = '0.1.0-rc.7'

/** Event envelope shape this plugin requires (spec §8.2). */
export function isSessionEventShape(value: unknown): value is { type: string; seq: number; time: number; data: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.type === 'string'
    && typeof record.seq === 'number'
    && typeof record.time === 'number'
    && typeof record.data === 'object'
    && record.data !== null
  )
}

/** Storage-domain service shape (required inject — absence already fails loading). */
export function hasDomainFacility(ctx: { get(name: string): unknown }): boolean {
  return ctx.get('storageDomain') !== undefined
}

/**
 * Verify the live Session surface used by replay (spec §8.3). The `sessions`
 * service is optional for core function (live tail still works without it),
 * but when present it must expose the methods replay relies on — otherwise we
 * fail loud with `dsh-version-unsupported` instead of silently degrading.
 */
export function sessionStoreSurface(sessions: unknown): 'full' | 'absent' {
  if (sessions === undefined) return 'absent'
  const store = sessions as { get?: unknown; list?: unknown }
  if (typeof store.get === 'function' && typeof store.list === 'function') return 'full'
  throw new Error(
    `outcome-loop: the mounted sessions service does not expose get()/list() — `
    + `DSH version not supported (verified against ${KNOWN_COMPATIBLE_DSH})`,
  )
}
