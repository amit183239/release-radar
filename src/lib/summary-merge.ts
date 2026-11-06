/**
 * Chunked persona-summary join for the feed route.
 *
 * D1 has a 100-parameter limit per statement. Each pair in the OR-chain costs
 * 2 binds (release_id + pr_number) and there is 1 bind for role, so:
 *   CHUNK=40 → 40×2 + 1 = 81 binds — safely under the cap.
 *
 * Merges results across chunks in a Map keyed by "${release_id}:${pr_number}".
 */

type Key = { release_id: string; pr_number: number }
type Row = { headline: string; body: string | null; source: 'ai' | 'fallback' }
type SummaryRawRow = { release_id: string; pr_number: number; headline: string; body: string | null; source: 'ai' | 'fallback' }

const CHUNK = 40 // 40 pairs × 2 binds + 1 role = 81 < D1's 100-param cap

export async function fetchSummariesForFeed(
  db: D1Database,
  role: string,
  keys: Key[],
): Promise<Map<string, Row>> {
  const out = new Map<string, Row>()
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    const clauses = chunk.map(() => '(release_id = ? AND pr_number = ?)').join(' OR ')
    const sql = `SELECT release_id, pr_number, headline, body, source FROM persona_summaries WHERE role = ? AND (${clauses})`
    const binds: (string | number)[] = [role, ...chunk.flatMap((p) => [p.release_id, p.pr_number])]
    const r = await db
      .prepare(sql)
      .bind(...binds)
      .all<SummaryRawRow>()
    for (const row of r.results) {
      out.set(`${row.release_id}:${row.pr_number}`, {
        headline: row.headline,
        body: row.body,
        source: row.source,
      })
    }
  }
  return out
}
