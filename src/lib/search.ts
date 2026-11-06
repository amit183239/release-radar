/**
 * One definition of "a note matches a query" (spec §2b). `/api/search` uses
 * SQLite `LIKE` (ASCII-only case folding); query follows test in JS with
 * `noteMatchesQuery`, which deliberately folds ASCII only so search, fan-out,
 * follow-backfill and read time can never disagree.
 */

/** Escape LIKE wildcards (`%`, `_`) and the escape char itself, for `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** Lower-case A–Z only (mirrors SQLite's built-in LIKE folding). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

/** True when the trimmed query is a substring of the note (ASCII-case-insensitive).
 *  An empty query or a null note never matches. */
export function noteMatchesQuery(note: string | null, q: string): boolean {
  const needle = q.trim()
  if (needle === '' || note == null) return false
  return asciiLower(note).includes(asciiLower(needle))
}
