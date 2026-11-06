/**
 * Sync-cursor arithmetic for the `updated:>=<cursor>` PR/issue search sweeps
 * (spec §0c). Pure. Cursors are ISO-8601 UTC timestamps pinned to
 * `YYYY-MM-DDTHH:MM:SSZ` — GitHub documents that form for search qualifiers and
 * does not document fractional seconds, so a millisecond suffix could silently
 * return zero results and stall the sync.
 */

/** One overlap for both syncs: re-read the last hour so edge items are never skipped. */
export const SYNC_OVERLAP_SECONDS = 3600

/** Overlap used when a sweep hit its page cap: absorbs offset-pagination shifts. */
const CAPPED_OVERLAP_SECONDS = 60

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

export function epochToCursor(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 19) + 'Z'
}

/** Legacy `YYYY-MM-DD` cursors (pre-§0c) become midnight UTC; millis are dropped;
 *  empty or unparseable values become null (caller falls back to its default window). */
export function normalizeCursor(c: string | null | undefined): string | null {
  if (!c) return null
  if (DATE_ONLY.test(c)) {
    // Calendar-invalid dates (e.g. 2026-13-45) must not be accepted.
    return Number.isFinite(Date.parse(`${c}T00:00:00Z`)) ? `${c}T00:00:00Z` : null
  }
  if (TIMESTAMP.test(c)) {
    const ms = Date.parse(c)
    return Number.isFinite(ms) ? epochToCursor(Math.floor(ms / 1000)) : null
  }
  return null
}

export function cursorToEpoch(c: string): number {
  const norm = normalizeCursor(c)
  if (norm === null) throw new Error(`invalid sync cursor: ${c}`)
  return Math.floor(Date.parse(norm) / 1000)
}

/**
 * Next cursor after a sweep.
 * - `maxSeen` is the max `updatedAt` OBSERVED this tick (never wall-clock).
 * - Zero items seen -> `prior` unchanged.
 * - Not capped -> `maxSeen - overlapSeconds`.
 * - Capped (page cap hit with more pages) -> `max(prior + 1, maxSeen - 60)`: a
 *   small overlap, but always strictly past `prior` so the window progresses.
 * - Never moves backward (compared as epoch, not string).
 */
export function nextSyncCursor(p: {
  prior: string | null
  maxSeen: number | null
  overlapSeconds: number
  capped: boolean
}): string | null {
  const prior = normalizeCursor(p.prior)
  if (p.maxSeen === null) return prior
  const priorEpoch = prior === null ? null : cursorToEpoch(prior)
  const candidate = p.capped
    ? Math.max(priorEpoch === null ? -Infinity : priorEpoch + 1, p.maxSeen - CAPPED_OVERLAP_SECONDS)
    : p.maxSeen - p.overlapSeconds
  const next = priorEpoch === null ? candidate : Math.max(priorEpoch, candidate)
  return epochToCursor(next)
}
