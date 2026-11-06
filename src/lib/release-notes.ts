/**
 * Curated release-note extraction (Phase 2, the ● curated vs ○ from-PR-title
 * distinction). A PR author opts into curated copy by adding a `## Release Note`
 * section to the PR body; text runs until the next heading or end of body.
 * Pure + testable.
 */

export interface ReleaseNoteResult {
  /** Curated note text, or null when the PR has no `## Release Note` section. */
  curated: string | null
  /** True when the author explicitly opted out (`skip-release-note` marker). */
  skip: boolean
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+release\s+notes?\s*$/i
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/
const SKIP_RE = /(^|\s)skip-release-note(\s|$)/i

export function extractReleaseNote(body: string | null | undefined): ReleaseNoteResult {
  if (!body) return { curated: null, skip: false }
  if (SKIP_RE.test(body)) return { curated: null, skip: true }

  const lines = body.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) {
      start = i + 1
      break
    }
  }
  if (start === -1) return { curated: null, skip: false }

  const collected: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (ANY_HEADING_RE.test(lines[i]!)) break // next section ends the note
    collected.push(lines[i]!)
  }
  const text = collected.join('\n').trim()
  return { curated: text.length > 0 ? text : null, skip: false }
}
