/** Issues browse surface (login-required): reads the entity cache (kind='issue'),
 *  open first then most-recently-updated, with the total for "Showing X of N". */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { resolveConfig } from '../config'
import { clampInt, parseLabels } from '../lib/http'

const issues = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
issues.use('/api/issues', requireAuth())

export interface IssueListItem {
  number: number
  title: string
  state: string
  labels: string[]
  milestone: string | null
  url: string
}

export async function listIssues(
  db: D1Database,
  repo: string,
  limit: number,
  offset: number
): Promise<{ issues: IssueListItem[]; total: number }> {
  const { results } = await db
    .prepare(
      `SELECT number, title, state, labels_json, milestone, url
         FROM entities
        WHERE repo = ? AND kind = 'issue'
        ORDER BY CASE WHEN state = 'OPEN' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT ? OFFSET ?`
    )
    .bind(repo, limit, offset)
    .all<{ number: number; title: string; state: string; labels_json: string | null; milestone: string | null; url: string }>()
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM entities WHERE repo = ? AND kind = 'issue'`)
    .bind(repo)
    .first<{ c: number }>()
  return {
    issues: (results ?? []).map((r) => ({
      number: r.number,
      title: r.title,
      state: r.state,
      labels: parseLabels(r.labels_json),
      milestone: r.milestone,
      url: r.url,
    })),
    total: totalRow?.c ?? 0,
  }
}

issues.get('/api/issues', async (c) => {
  const { ownerRepo } = resolveConfig(c.env)
  const limit = clampInt(c.req.query('limit'), 50, 200)
  const offset = Math.max(Number.parseInt(c.req.query('offset') ?? '', 10) || 0, 0)
  return c.json(await listIssues(c.env.DB, ownerRepo, limit, offset))
})

export default issues
