/**
 * Feed + in-app notifications API (Phase 2). The feed IS the notification
 * surface. Login-required. `unread=1` filters to unread; a badge count and
 * mark-read verbs support the in-app bell.
 */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { resolveConfig } from '../config'
import { listFeed, listPersonaDigest, unreadCount, markRead, markAllRead } from '../lib/events'
import { getRole, type Voice } from '../lib/roles'
import { fetchSummariesForFeed } from '../lib/summary-merge'

/**
 * Map a viewer's role voice to the generated summary role to look up.
 * Only 'developer' and 'cx' summaries are ever generated; customer-voiced
 * roles (cx, sales, pm) receive cx summaries, technical-voiced roles receive
 * developer summaries. Display-only — does not change what is generated.
 */
export function voiceToSummaryRole(voice: Voice): 'developer' | 'cx' {
  return voice === 'customer' ? 'cx' : 'developer'
}

const feed = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

feed.use('/api/feed', requireAuth())
feed.use('/api/feed/*', requireAuth())
feed.use('/api/notifications/*', requireAuth())

/** GET /api/feed?unread=1&limit=50 — unified feed with role-shaped persona summaries. */
feed.get('/api/feed', async (c) => {
  const { userId } = c.get('auth')
  const { ownerRepo } = resolveConfig(c.env)
  const items = await listFeed(c.env.DB, userId, ownerRepo, {
    unreadOnly: c.req.query('unread') === '1',
    limit: Number.parseInt(c.req.query('limit') ?? '', 10) || undefined,
  })
  const userRow = await c.env.DB.prepare('SELECT lens_profile FROM users WHERE id = ?').bind(userId).first<{ lens_profile: string }>()
  const roleDef = getRole(userRow?.lens_profile)
  // Map viewer role to the generated summary role by voice: customer-voiced roles get
  // cx summaries; all others (technical) get developer summaries. This ensures
  // support/sales/pm viewers receive a populated summary card rather than null,
  // without expanding the generation scope (only developer+cx are ever generated).
  const summaryRole = voiceToSummaryRole(roleDef.voice)
  const keys = items.filter((i) => i.release_id != null && i.pr_number != null).map((i) => ({ release_id: i.release_id!, pr_number: i.pr_number! }))
  const summaries = await fetchSummariesForFeed(c.env.DB, summaryRole, keys)
  const withSummaries = items.map((i) => ({
    ...i,
    summary: (i.release_id != null && i.pr_number != null && summaries.get(`${i.release_id}:${i.pr_number}`))
      ? { ...summaries.get(`${i.release_id}:${i.pr_number}`)!, role: summaryRole }
      : null,
  }))
  return c.json({ items: withSummaries })
})

// Repo-global: persona_summaries has no repo column (single-repo deployment); revisit for multi-repo.
/** GET /api/feed/digest — role-shaped digest of all ai summaries, NOT follow-gated. */
feed.get('/api/feed/digest', async (c) => {
  const { userId } = c.get('auth')
  const userRow = await c.env.DB.prepare('SELECT lens_profile FROM users WHERE id = ?')
    .bind(userId).first<{ lens_profile: string }>()
  const role = voiceToSummaryRole(getRole(userRow?.lens_profile).voice)
  const items = await listPersonaDigest(c.env.DB, role, 100)
  return c.json({ role, items })
})

/** POST /api/feed/summarize — async summarize trigger (no-op stub; 202 accepted). */
feed.post('/api/feed/summarize', (c) => c.json({ status: 'accepted' }, 202))

/** GET /api/notifications/unread-count — badge count. */
feed.get('/api/notifications/unread-count', async (c) => {
  const { userId } = c.get('auth')
  return c.json({ count: await unreadCount(c.env.DB, userId) })
})

/** POST /api/feed/:id/read — mark one item read. */
feed.post('/api/feed/:id/read', async (c) => {
  const { userId } = c.get('auth')
  const ok = await markRead(c.env.DB, userId, c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

/** POST /api/feed/read-all — mark everything read. */
feed.post('/api/feed/read-all', async (c) => {
  const { userId } = c.get('auth')
  return c.json({ marked: await markAllRead(c.env.DB, userId) })
})

export { feed }
export default feed
