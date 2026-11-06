/** Role-specific insights API (login-required). Uses the caller's stored role
 *  unless ?role= overrides; window in days (default 30, capped 365); optional
 *  ?app= scopes to one app. */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { resolveConfig } from '../config'
import { computeInsights } from '../lib/insights'
import { getRole } from '../lib/roles'
import { nowSeconds } from '../lib/helpers'

const insights = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
insights.use('/api/insights', requireAuth())

insights.get('/api/insights', async (c) => {
  const { userId } = c.get('auth')
  let roleKey = c.req.query('role') ?? ''
  if (!roleKey) {
    const row = await c.env.DB.prepare('SELECT lens_profile FROM users WHERE id = ?')
      .bind(userId)
      .first<{ lens_profile: string }>()
    roleKey = row?.lens_profile ?? 'developer'
  }
  const windowDays = clampWindow(c.req.query('window'))
  const app = c.req.query('app') || undefined
  const { ownerRepo } = resolveConfig(c.env)
  const result = await computeInsights(c.env.DB, {
    repo: ownerRepo, roleKey: getRole(roleKey).key, windowDays, app, now: nowSeconds(),
  })
  return c.json(result)
})

function clampWindow(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return 30
  return Math.min(n, 365)
}

export default insights
