/**
 * Small shared HTTP-route helpers (replaces per-route copies in api.ts,
 * suggest.ts, issues.ts). `clampWindow` (insights, snap-to-set) and
 * `clampSummary` (string length) are different operations and stay where they are.
 */
import { parseJsonArray } from './json'

/** Parse a positive int query param: missing/non-numeric/<1 -> dflt; else min(n, max). */
export function clampInt(raw: string | undefined, dflt: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return dflt
  return Math.min(n, max)
}

/** Labels stored as a JSON array column; non-string entries are dropped. */
export function parseLabels(json: string | null): string[] {
  return parseJsonArray<unknown>(json).filter((l): l is string => typeof l === 'string')
}
