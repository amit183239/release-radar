/**
 * Read API (Phase 1). Every route is login-required (§2: no public surface).
 * The Dev-lens changelog: apps directory + per-app release timeline with its
 * per-PR notes. Follow/feed/search + the CX lens land in Phase 2/3.
 */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { resolveConfig } from '../config'
import { escapeLike } from '../lib/search'
import { clampInt, parseLabels } from '../lib/http'
import { getRole, noteMatchesRole } from '../lib/roles'

const api = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

api.use('/api/*', requireAuth())

/** GET /api/apps — the apps directory. */
api.get('/api/apps', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT slug, display_name, visibility, synthetic, last_ref_at
       FROM apps ORDER BY slug`
  ).all()
  return c.json({ apps: results ?? [] })
})

/** GET /api/apps/:slug/releases — per-app changelog, newest deploy first. */
api.get('/api/apps/:slug/releases', async (c) => {
  const slug = c.req.param('slug')
  const limit = clampInt(c.req.query('limit'), 50, 200)
  const { results } = await c.env.DB.prepare(
    `SELECT id, app, ref, tag, deployed_at, base_ref, divergent
       FROM releases WHERE app = ?
       ORDER BY deployed_at DESC LIMIT ?`
  )
    .bind(slug, limit)
    .all()
  return c.json({ app: slug, releases: results ?? [] })
})

/** Pure mapper: derive `note` and `customer_source` from a row + voice.
 *  Exported for unit tests (cx-changelog.test.ts). */
export function mapChangelogNote(
  r: {
    note_technical: string | null
    note_customer: string | null
    customer_source: string | null
    ps_headline: string | null
    ps_body: string | null
    ps_source: string | null
  },
  voice: string,
): { note: string | null; customer_source: string | null } {
  const isCustomer = voice === 'customer'
  const note = isCustomer
    ? r.ps_headline
      ? r.ps_body
        ? `${r.ps_headline} — ${r.ps_body}`
        : r.ps_headline
      : r.note_customer ?? r.note_technical
    : r.note_technical
  const customer_source = isCustomer
    ? r.ps_headline
      ? 'ai'
      : r.note_customer
        ? (r.customer_source ?? 'ai')
        : 'fallback'
    : r.customer_source
  return { note, customer_source }
}

/** GET /api/releases/:id/notes?role=<key> — per-PR entries filtered by role.
 *  Labels come from the PR entity cache; the role's voice picks the copy.
 *  CX copy is read-derived from persona_summaries (role='cx', source='ai'),
 *  falling back to legacy note_customer / note_technical. */
api.get('/api/releases/:id/notes', async (c) => {
  const id = c.req.param('id')
  const role = getRole(c.req.query('role'))
  const { ownerRepo } = resolveConfig(c.env)
  const { results } = await c.env.DB.prepare(
    `SELECT n.pr_number, n.note_technical, n.note_customer, n.copy_source,
            n.customer_source, n.customer_facing, n.author, n.url,
            e.labels_json,
            ps.headline AS ps_headline,
            ps.body     AS ps_body,
            ps.source   AS ps_source
       FROM notes n
       LEFT JOIN entities e
         ON e.repo = ?1 AND e.kind = 'pr' AND e.number = n.pr_number
       LEFT JOIN persona_summaries ps
         ON ps.release_id = n.release_id
        AND ps.pr_number  = n.pr_number
        AND ps.role       = 'cx'
        AND ps.source     = 'ai'
      WHERE n.release_id = ?2
      ORDER BY n.pr_number`
  )
    .bind(ownerRepo, id)
    .all<{
      pr_number: number
      note_technical: string | null
      note_customer: string | null
      copy_source: string | null
      customer_source: string | null
      customer_facing: number
      author: string | null
      url: string | null
      labels_json: string | null
      ps_headline: string | null
      ps_body: string | null
      ps_source: string | null
    }>()

  const notes = (results ?? [])
    .map((r) => ({ ...r, labels: parseLabels(r.labels_json) }))
    .filter((r) => noteMatchesRole(r, role))
    .map((r) => {
      const { note, customer_source } = mapChangelogNote(r, role.voice)
      return {
        pr_number: r.pr_number,
        note_technical: r.note_technical,
        note_customer: r.note_customer,
        note,
        copy_source: r.copy_source,
        customer_source,
        customer_facing: r.customer_facing,
        author: r.author,
        url: r.url,
        labels: r.labels,
        ps_headline: r.ps_headline,
        ps_body: r.ps_body,
        ps_source: r.ps_source,
      }
    })
  return c.json({ release_id: id, role: role.key, notes })
})

/** GET /api/search?q=… — text search across changelog notes (Phase 2). */
api.get('/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) {
    return c.json({ error: 'q must be at least 2 characters', results: [] }, 400)
  }
  const limit = clampInt(c.req.query('limit'), 50, 200)
  // Escape LIKE wildcards in user input; match as a contains-substring.
  const needle = `%${escapeLike(q)}%`
  const { results } = await c.env.DB.prepare(
    `SELECT n.app, n.pr_number, n.note_technical, n.copy_source, n.url,
            r.tag, r.deployed_at
       FROM notes n
       JOIN releases r ON r.id = n.release_id
      WHERE n.note_technical LIKE ?1 ESCAPE '\\'
      ORDER BY r.deployed_at DESC
      LIMIT ?2`
  )
    .bind(needle, limit)
    .all()
  return c.json({ query: q, results: results ?? [] })
})

export default api
