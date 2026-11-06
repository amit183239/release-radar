/** Returns a normalized href only for absolute `https:` URLs; anything else
 *  (javascript:, data:, http:, relative, garbage) → null, so callers render
 *  plain text instead of a link. Used for data-derived links (ticket_ref,
 *  activity payload.url) — never trust them as hrefs directly. */
export function safeUrl(s: string | null | undefined): string | null {
  if (!s) return null
  try {
    const u = new URL(s.trim())
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
