/**
 * Shared JSON parsing utilities used across jobs.
 */

/**
 * Parse a JSON-encoded array stored in a D1 column.
 * Returns the typed array on success; returns `[]` for null/undefined input,
 * non-array values, or any parse error — callers must never receive a throw.
 */
export function parseJsonArray<T>(json: string | null | undefined): T[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}
