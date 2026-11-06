/**
 * /auth sub-app: the OAuth SSO login flow with the config-driven fail-closed
 * domain gate. Mounted at /auth by src/app.ts.
 *
 *   GET  /auth/login     -> PKCE + state, redirect to the IdP authorize URL
 *   GET  /auth/callback  -> validate state, exchange code, gate, mint session
 *   GET  /auth/me        -> current user (login-required)
 *   GET  /auth/logout    -> clear session
 */
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from '../env'
import { resolveConfig } from '../config'
import { OAuthProvider } from './oauth/provider'
import { checkDomainGate } from './provider'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateStateNonce,
  constantTimeEqual,
} from './oauth-crypto'
import { encrypt } from './encryption'
import {
  upsertUser,
  createSession,
  rotatePriorSession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  deleteSession,
  SESSION_COOKIE,
} from './session'
import { requireAuth, type AuthContext } from './middleware'
import { nowSeconds } from '../lib/helpers'

const PKCE_COOKIE = 'rr_pkce_verifier'
const STATE_COOKIE = 'rr_oauth_state'
const OAUTH_COOKIE_TTL = 600 // 10 minutes

const auth = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

auth.get('/auth/login', async (c) => {
  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const nonce = generateStateNonce()
  const state = btoa(JSON.stringify({ nonce }))
  const redirectUri = `${c.env.APP_URL}/auth/callback`

  const provider = new OAuthProvider(c.env)
  const url = provider.buildAuthorizeUrl({
    redirectUri,
    state,
    codeChallenge: challenge,
  })

  const cookieOpts = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    maxAge: OAUTH_COOKIE_TTL,
  }
  setCookie(c, PKCE_COOKIE, verifier, cookieOpts)
  setCookie(c, STATE_COOKIE, nonce, cookieOpts)
  return c.redirect(url)
})

auth.get('/auth/callback', async (c) => {
  // DEBUG-only: surface the specific failure reason in the redirect + logs so a
  // local dev can see WHY auth failed. Never leaks in a deployed env (DEBUG=false).
  const authErr = (reason: string, detail?: string) => {
    if (detail) console.error(`[auth:callback] ${reason}:`, detail)
    const base = `${c.env.APP_URL}/auth/error?code=${reason}`
    const url =
      c.env.DEBUG === 'true' && detail
        ? `${base}&detail=${encodeURIComponent(detail)}`
        : base
    return c.redirect(url, 302)
  }

  const code = c.req.query('code')
  const stateParam = c.req.query('state')
  if (!code || !stateParam) {
    const idpErr = c.req.query('error')
    const idpDesc = c.req.query('error_description')
    return authErr(
      'auth_failed',
      `no code/state on callback — idp_error=${idpErr ?? 'none'} desc=${idpDesc ?? 'none'} (code=${code ? 'present' : 'MISSING'}, state=${stateParam ? 'present' : 'MISSING'})`
    )
  }

  // CSRF: state nonce must match the browser cookie.
  const stateCookie = getCookie(c, STATE_COOKIE)
  if (!stateCookie) return authErr('session_expired')
  let nonce: string
  try {
    nonce = (JSON.parse(atob(stateParam)) as { nonce: string }).nonce
  } catch {
    return authErr('session_expired')
  }
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  if (typeof nonce !== 'string' || !constantTimeEqual(nonce, stateCookie)) {
    return authErr('session_expired')
  }

  const verifier = getCookie(c, PKCE_COOKIE)
  if (!verifier) return authErr('session_expired')
  deleteCookie(c, PKCE_COOKIE, { path: '/' })

  const provider = new OAuthProvider(c.env)
  let profile
  try {
    profile = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: `${c.env.APP_URL}/auth/callback`,
    })
  } catch (e) {
    return authErr('auth_failed', e instanceof Error ? e.message : String(e))
  }

  // Fail-closed gate: verified email in an allowed domain, else refuse.
  const config = resolveConfig(c.env)
  const gate = checkDomainGate(profile, config.allowedDomains)
  if (!gate.allowed) {
    console.warn('[auth] gate denied', { reason: gate.reason })
    return authErr('forbidden')
  }

  await rotatePriorSession(c, c.env.DB)
  const userId = await upsertUser(c.env.DB, {
    email: profile.email,
    name: profile.name ?? null,
  })

  let encTokens: string | null = null
  if (profile.tokens) {
    try {
      encTokens = await encrypt(
        JSON.stringify(profile.tokens),
        c.env.SESSION_ENCRYPTION_KEY
      )
    } catch (e) {
      console.error('[auth] token encryption failed:', typeof e)
      return authErr('internal')
    }
  }

  const session = await createSession(c.env.DB, {
    userId,
    email: profile.email,
    oauthUserId: profile.providerUserId,
    encTokens,
    tokenExpiresAt: null,
  })
  setSessionCookie(c, session.id, session.expires_at)
  return c.redirect(c.env.APP_URL)
})

auth.get('/auth/me', requireAuth(), (c) => {
  const a = c.get('auth')
  return c.json({ userId: a.userId, email: a.email })
})

/**
 * DEBUG-ONLY dev login. Hard-gated to DEBUG=true so it can NEVER mint a session
 * in a deployed env (prod/sandbox run DEBUG=false). Bypasses OAuth entirely so
 * the app is browsable locally without OAuth. The fixed dev user matches the id
 * used by seed.dev.sql.
 */
const DEV_USER_ID = '00000000-0000-4000-8000-000000000001'
const DEV_USER_EMAIL = 'dev@example.com'
auth.get('/auth/dev-login', async (c) => {
  if (c.env.DEBUG !== 'true') return c.json({ error: 'not available' }, 403)
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, created_at)
     VALUES (?, ?, 'Dev User', ?)
     ON CONFLICT(email) DO NOTHING`
  )
    .bind(DEV_USER_ID, DEV_USER_EMAIL, nowSeconds())
    .run()
  const row = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(DEV_USER_EMAIL)
    .first<{ id: string }>()
  const userId = row?.id ?? DEV_USER_ID
  await rotatePriorSession(c, c.env.DB)
  const session = await createSession(c.env.DB, {
    userId,
    email: DEV_USER_EMAIL,
    oauthUserId: 'dev',
    encTokens: null,
    tokenExpiresAt: null,
  })
  setSessionCookie(c, session.id, session.expires_at)
  return c.redirect(c.env.APP_URL)
})

auth.get('/auth/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE)
  if (sessionId) {
    try {
      // Only clear a session that actually exists; ignore blips.
      if (await getSession(c.env.DB, sessionId)) {
        await deleteSession(c.env.DB, sessionId)
      }
    } catch (e) {
      console.warn('[auth] logout delete failed:', typeof e)
    }
  }
  clearSessionCookie(c)
  return c.redirect(c.env.APP_URL)
})

export default auth
