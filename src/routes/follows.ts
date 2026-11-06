/**
 * Follow API (Phase 2). Login-required. One endpoint per verb over the follow
 * primitive; "subscribe to an app" = POST a follow with target_type "app".
 */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { resolveConfig } from '../config'
import {
  createFollow,
  deleteFollow,
  listFollows,
} from '../lib/follows'
import { validateFollowInput } from '../lib/follow-validation'
import { backfillFollowFeed } from '../lib/events'

const follows = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

follows.use('/api/follows', requireAuth())
follows.use('/api/follows/*', requireAuth())

follows.get('/api/follows', async (c) => {
  const { userId } = c.get('auth')
  const { ownerRepo } = resolveConfig(c.env)
  return c.json({ follows: await listFollows(c.env.DB, userId, ownerRepo) })
})

follows.post('/api/follows', async (c) => {
  const { userId } = c.get('auth')
  // Server-side validation is the source of truth (UI mirrors it): trimmed refs,
  // query 3-200, other types <= 200, customer/ticket refs issue/pr-only.
  const v = validateFollowInput(await c.req.json().catch(() => null))
  if (!v.ok) return c.json({ error: v.error }, 400)
  const { targetType, targetRef, customerRef, ticketRef } = v.value
  const id = await createFollow(c.env.DB, {
    userId,
    targetType,
    targetRef,
    // Opaque CRM link only (never a customer name / routable target).
    customerRef,
    ticketRef,
  })
  // Seed the feed with the target's last-week activity so it shows immediately.
  const { ownerRepo } = resolveConfig(c.env)
  const seeded = await backfillFollowFeed(c.env.DB, userId, ownerRepo, targetType, targetRef)
  return c.json({ id, seeded }, 201)
})

follows.delete('/api/follows/:id', async (c) => {
  const { userId } = c.get('auth')
  const ok = await deleteFollow(c.env.DB, userId, c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

export default follows
