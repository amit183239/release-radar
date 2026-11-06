import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import type { Env } from '../env'
import { getSession, SESSION_COOKIE } from './session'
import { nowSeconds } from '../lib/helpers'

/** Authenticated context set by requireAuth for downstream handlers. */
export interface AuthContext {
  userId: string
  email: string | null
}

/**
 * Gate a route on a valid, unexpired session cookie. Every read surface is
 * login-required (§2: no public signed-out page). Returns 401 JSON otherwise.
 */
export function requireAuth() {
  return createMiddleware<{
    Bindings: Env
    Variables: { auth: AuthContext }
  }>(async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE)
    if (!sessionId) return c.json({ error: 'Unauthorized: no session.' }, 401)

    const session = await getSession(c.env.DB, sessionId)
    if (!session) return c.json({ error: 'Unauthorized: invalid session.' }, 401)
    if (session.expires_at < nowSeconds()) {
      return c.json({ error: 'Unauthorized: session expired.' }, 401)
    }

    c.set('auth', { userId: session.user_id, email: session.email })
    await next()
  })
}
