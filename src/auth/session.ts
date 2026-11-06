/**
 * Server-side sessions. The cookie value IS the session id (bearer credential),
 * so it is HttpOnly/Secure/SameSite=Lax and rotated on login (fixation defense).
 * OAuth tokens are stored encrypted (auth/encryption.ts).
 */
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { newId, nowSeconds } from '../lib/helpers'

export const SESSION_COOKIE = 'rr_session'
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

export interface SessionRow {
  id: string
  user_id: string
  email: string | null
  oauth_user_id: string | null
  oauth_team_id: string | null
  enc_oauth_tokens: string | null
  token_expires_at: number | null
  expires_at: number
  created_at: number
}

/** Insert-or-update the user by email; returns the user id. lens_profile is left
 *  to the column default on first insert; an existing user's lens is preserved. */
export async function upsertUser(
  db: D1Database,
  params: { email: string; name: string | null }
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO users (id, email, name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name)
       RETURNING id`
    )
    .bind(newId(), params.email, params.name, nowSeconds())
    .first<{ id: string }>()
  if (!row) throw new Error('upsertUser returned no id')
  return row.id
}

export async function createSession(
  db: D1Database,
  params: {
    userId: string
    email: string
    oauthUserId: string | null
    encTokens: string | null
    tokenExpiresAt: number | null
  }
): Promise<SessionRow> {
  const now = nowSeconds()
  const session: SessionRow = {
    id: newId(),
    user_id: params.userId,
    email: params.email,
    oauth_user_id: params.oauthUserId,
    oauth_team_id: null,
    enc_oauth_tokens: params.encTokens,
    token_expires_at: params.tokenExpiresAt,
    expires_at: now + SESSION_TTL_SECONDS,
    created_at: now,
  }
  await db
    .prepare(
      `INSERT INTO sessions
         (id, user_id, email, oauth_user_id, oauth_team_id,
          enc_oauth_tokens, token_expires_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      session.id,
      session.user_id,
      session.email,
      session.oauth_user_id,
      session.oauth_team_id,
      session.enc_oauth_tokens,
      session.token_expires_at,
      session.expires_at,
      session.created_at
    )
    .run()
  return session
}

export async function getSession(
  db: D1Database,
  id: string
): Promise<SessionRow | null> {
  return db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>()
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run()
}

/**
 * Session-fixation defense: blow away any session the browser already presents
 * before minting a new one. Best-effort — a delete blip must not fail login.
 */
export async function rotatePriorSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  db: D1Database
): Promise<void> {
  const prior = getCookie(c, SESSION_COOKIE)
  if (!prior) return
  try {
    await deleteSession(db, prior)
  } catch (e) {
    console.warn('[auth] rotatePriorSession failed:', typeof e)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setSessionCookie(c: Context<any>, id: string, expiresAtEpoch: number): void {
  setCookie(c, SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    expires: new Date(expiresAtEpoch * 1000),
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function clearSessionCookie(c: Context<any>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}
