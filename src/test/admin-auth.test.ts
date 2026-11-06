import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { tokenMatches } from '../lib/admin-auth'
import { admin, debugOnly, debugOrToken } from '../routes/admin'
import { makeTestDb } from './helpers/d1'

const SECRET = 's3cret-admin-token-value'

describe('tokenMatches', () => {
  it('accepts the exact Bearer token', async () => {
    expect(await tokenMatches(`Bearer ${SECRET}`, SECRET)).toBe(true)
  })
  it('rejects a wrong token, a prefix, and a longer token', async () => {
    expect(await tokenMatches('Bearer nope', SECRET)).toBe(false)
    expect(await tokenMatches(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false)
    expect(await tokenMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false)
  })
  it('rejects a missing header, a non-Bearer scheme, and an empty token', async () => {
    expect(await tokenMatches(undefined, SECRET)).toBe(false)
    expect(await tokenMatches(`Basic ${SECRET}`, SECRET)).toBe(false)
    expect(await tokenMatches(SECRET, SECRET)).toBe(false)
    expect(await tokenMatches('Bearer ', SECRET)).toBe(false)
  })
  it('fails closed when the secret is unset or empty', async () => {
    expect(await tokenMatches('Bearer anything', undefined)).toBe(false)
    expect(await tokenMatches('Bearer ', '')).toBe(false)
    expect(await tokenMatches('Bearer x', '')).toBe(false)
  })
})

// Exercise the middleware on a probe app so no real job (network) ever runs.
function probe() {
  const app = new Hono<{ Bindings: { DEBUG?: string; ADMIN_TOKEN?: string } }>()
  app.all('/tok', debugOrToken, (c) => c.json({ ok: true }))
  app.all('/dbg', debugOnly, (c) => c.json({ ok: true }))
  return app
}
const auth = { Authorization: `Bearer ${SECRET}` }

describe('debugOrToken', () => {
  it('passes with DEBUG=true (any method, no token)', async () => {
    const res = await probe().request('/tok', { method: 'GET' }, { DEBUG: 'true' })
    expect(res.status).toBe(200)
  })
  it('passes a POST with a valid token when DEBUG is off', async () => {
    const res = await probe().request('/tok', { method: 'POST', headers: auth }, { DEBUG: 'false', ADMIN_TOKEN: SECRET })
    expect(res.status).toBe(200)
  })
  it('rejects GET on the token path even with a valid token', async () => {
    const res = await probe().request('/tok', { method: 'GET', headers: auth }, { DEBUG: 'false', ADMIN_TOKEN: SECRET })
    expect(res.status).toBe(403)
  })
  it('rejects POST with a wrong token, and with ADMIN_TOKEN unset', async () => {
    const bad = await probe().request('/tok', { method: 'POST', headers: { Authorization: 'Bearer wrong' } }, { DEBUG: 'false', ADMIN_TOKEN: SECRET })
    expect(bad.status).toBe(403)
    const unset = await probe().request('/tok', { method: 'POST', headers: auth }, { DEBUG: 'false' })
    expect(unset.status).toBe(403)
    expect(await unset.json()).toEqual({ error: 'not available' })
  })
})

describe('debugOnly', () => {
  it('passes with DEBUG=true and rejects a valid token when DEBUG is off', async () => {
    expect((await probe().request('/dbg', { method: 'POST' }, { DEBUG: 'true' })).status).toBe(200)
    const res = await probe().request('/dbg', { method: 'POST', headers: auth }, { DEBUG: 'false', ADMIN_TOKEN: SECRET })
    expect(res.status).toBe(403)
  })
})

describe('real admin routes (deny paths only — nothing executes)', () => {
  const env = (db: unknown) => ({ DB: db, DEBUG: 'false', ADMIN_TOKEN: SECRET })
  it('a valid token still gets 403 on the AI-spending routes', async () => {
    const db = makeTestDb()
    for (const path of ['/admin/ai-summaries', '/admin/redrain?confirm=1']) {
      const res = await admin.request(path, { method: 'POST', headers: auth }, env(db) as any)
      expect(res.status).toBe(403)
    }
  })
  it('poll/backfill reject GET with a token and POST without one', async () => {
    const db = makeTestDb()
    for (const path of ['/admin/poll', '/admin/backfill']) {
      expect((await admin.request(path, { method: 'GET', headers: auth }, env(db) as any)).status).toBe(403)
      expect((await admin.request(path, { method: 'POST' }, env(db) as any)).status).toBe(403)
    }
  })
})
