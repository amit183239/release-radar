// src/routes/me.ts
/**
 * Current-user + role (Phase: role system). Every user has a stored role
 * (users.lens_profile, keyed to src/lib/roles.ts) chosen at first login
 * (role_chosen) and changed on Settings. The role drives the changelog filter
 * (?role=) and insights. Login-required.
 */
import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAuth, type AuthContext } from '../auth/middleware'
import { ROLES, isRoleKey } from '../lib/roles'

const me = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

me.use('/api/me', requireAuth())
me.use('/api/me/*', requireAuth())
me.use('/api/roles', requireAuth())

/** GET /api/roles — the role registry (drives the picker + Settings). */
me.get('/api/roles', (c) =>
  c.json({ roles: ROLES.map((r) => ({ key: r.key, label: r.label, blurb: r.blurb, voice: r.voice })) })
)

/** GET /api/me — profile + active role + whether it was explicitly chosen. */
me.get('/api/me', async (c) => {
  const { userId } = c.get('auth')
  const row = await c.env.DB.prepare(
    'SELECT email, name, lens_profile, role_chosen FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{ email: string; name: string | null; lens_profile: string; role_chosen: number }>()
  if (!row) return c.json({ error: 'user not found' }, 404)
  return c.json({
    email: row.email,
    name: row.name,
    role: row.lens_profile,
    role_chosen: row.role_chosen === 1,
  })
})

/** PATCH /api/me/role { role } — set the active role and mark it chosen. */
me.patch('/api/me/role', async (c) => {
  const { userId } = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const role = body?.role
  if (typeof role !== 'string' || !isRoleKey(role)) {
    return c.json({ error: `role must be one of ${ROLES.map((r) => r.key).join(', ')}` }, 400)
  }
  const result = await c.env.DB.prepare('UPDATE users SET lens_profile = ?, role_chosen = 1 WHERE id = ?')
    .bind(role, userId)
    .run()
  if (result.meta.changes === 0) return c.json({ error: 'user not found' }, 404)
  return c.json({ role })
})

export default me
