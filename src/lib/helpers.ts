/**
 * Shared query-layer primitives. Pure functions only — no D1 access. Vendored
 * from the billing app's `lib/queries/_helpers.ts` conventions (standalone
 * repo, so copied not imported): epoch-int timestamps, UUIDv4 ids, parameterized
 * partial updates.
 */

import type { SummaryInput } from '../ai/persona-summaries'

/** Current Unix epoch in seconds (integer). All DB timestamps are epoch ints. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * UUIDv4 for all TEXT id columns. Web Crypto only (the `ulid` package isn't
 * Workers-compatible — it needs Node's crypto.randomBytes).
 */
export function newId(): string {
  return crypto.randomUUID()
}

/** `?`-placeholder list of the same length as `arr` for `IN (...)` clauses. */
export function placeholdersFor(arr: unknown[]): string {
  return arr.map(() => '?').join(', ')
}

/**
 * Build a parameterized partial UPDATE. Fields whose value is `undefined` are
 * skipped; the id binding is appended by the caller via
 * `bind(...bindings, id)`. Returns `{ sql: '', bindings: [] }` when nothing is
 * left to set so callers can early-return instead of preparing a no-op.
 */
export function buildPartialUpdate(
  table: string,
  fields: Record<string, unknown>,
  idColumn = 'id'
): { sql: string; bindings: unknown[] } {
  const sets: string[] = []
  const bindings: unknown[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${key} = ?`)
    bindings.push(value)
  }
  if (sets.length === 0) return { sql: '', bindings: [] }
  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${idColumn} = ?`,
    bindings,
  }
}

/**
 * Stable 16-hex-char fingerprint for a SummaryInput + version string.
 * Web Crypto only — first 8 bytes of SHA-256 as hex.
 * The version is folded in as `_v` so bumping PERSONA_SUMMARY_VERSION
 * produces a new hash and forces re-generation of all ai rows.
 */
export async function hashSummaryInput(input: SummaryInput, version: string): Promise<string> {
  const json = JSON.stringify({ ...input, _v: version })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
