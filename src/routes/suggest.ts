/**
 * Follow autocomplete (login-required). Type-scoped suggestions for the
 * follow-by-reference typeahead: apps from the registry, labels + milestones from
 * the entity cache (json_each over labels_json / DISTINCT milestone), issues/PRs
 * from the entity cache by title/number. Returns { ref, title, state? } — `ref` is
 * what to follow.
 */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { resolveConfig } from '../config'
import { clampInt } from '../lib/http'
import { escapeLike } from '../lib/search'

const suggest = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
suggest.use('/api/suggest', requireAuth())

interface Suggestion {
  ref: string
  title: string
  state?: string | null
}

/** Distinct milestone titles (issues + PRs) for the repo, contains-match. */
export async function suggestMilestones(
  db: D1Database,
  repo: string,
  q: string,
  limit: number
): Promise<Suggestion[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT milestone AS ref FROM entities
        WHERE repo = ? AND milestone IS NOT NULL
          AND milestone LIKE ? ESCAPE '\\'
        ORDER BY milestone LIMIT ?`
    )
    .bind(repo, `%${escapeLike(q)}%`, limit)
    .all<{ ref: string }>()
  return (results ?? []).map((r) => ({ ref: r.ref, title: r.ref }))
}

suggest.get('/api/suggest', async (c) => {
  const type = c.req.query('type') ?? ''
  const q = (c.req.query('q') ?? '').trim()
  const limit = clampInt(c.req.query('limit'), 10, 25)
  const { ownerRepo } = resolveConfig(c.env)
  // Escape LIKE wildcards in user input; match as a contains-substring.
  const needle = `%${escapeLike(q)}%`

  let suggestions: Suggestion[] = []
  if (type === 'app') {
    const { results } = await c.env.DB.prepare(
      `SELECT slug, display_name FROM apps
        WHERE slug LIKE ?1 ESCAPE '\\' OR display_name LIKE ?1 ESCAPE '\\'
        ORDER BY slug LIMIT ?2`
    )
      .bind(needle, limit)
      .all<{ slug: string; display_name: string }>()
    suggestions = (results ?? []).map((r) => ({ ref: r.slug, title: r.display_name }))
  } else if (type === 'label') {
    const { results } = await c.env.DB.prepare(
      `SELECT DISTINCT je.value AS ref
         FROM entities e, json_each(e.labels_json) je
        WHERE e.repo = ?1 AND e.labels_json IS NOT NULL
          AND je.value LIKE ?2 ESCAPE '\\'
        ORDER BY je.value LIMIT ?3`
    )
      .bind(ownerRepo, needle, limit)
      .all<{ ref: string }>()
    suggestions = (results ?? []).map((r) => ({ ref: r.ref, title: r.ref }))
  } else if (type === 'milestone') {
    suggestions = await suggestMilestones(c.env.DB, ownerRepo, q, limit)
  } else if (type === 'issue' || type === 'pr') {
    const { results } = await c.env.DB.prepare(
      `SELECT number, title, state FROM entities
        WHERE repo = ?1 AND kind = ?2
          AND (title LIKE ?3 ESCAPE '\\' OR CAST(number AS TEXT) LIKE ?3 ESCAPE '\\')
        ORDER BY CASE WHEN state = 'OPEN' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT ?4`
    )
      .bind(ownerRepo, type, needle, limit)
      .all<{ number: number; title: string | null; state: string | null }>()
    suggestions = (results ?? []).map((r) => ({
      ref: String(r.number),
      title: `#${r.number} ${r.title ?? ''}`.trim(),
      state: r.state,
    }))
  } else {
    return c.json({ error: 'type must be one of app, label, milestone, issue, pr' }, 400)
  }
  return c.json({ suggestions })
})

export default suggest
