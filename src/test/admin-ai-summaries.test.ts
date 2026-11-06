import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { admin } from '../routes/admin'

// Minimal env shape required by resolveConfig (mirrored from ai-summaries.test.ts).
const BASE_ENV = {
  GITHUB_REPO: 'o/r',
  AI_MONTHLY_CAP_CENTS: '500',
  RELEASE_TAG_PATTERN: '{app}-*-production',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  BACKFILL_DAYS: '90',
  MAPPING_JSON_PATH: '.github/mapping.json',
  SHARED_LIB_BUCKET: 'platform',
  CUSTOMER_FACING_LABELS: 'customer-facing',
}

describe('/admin/ai-summaries route', () => {
  it('returns 403 when DEBUG is not "true" (fail-closed guard)', async () => {
    const db = makeTestDb()
    const env = { ...BASE_ENV, AI_PROVIDER: 'off', DEBUG: 'false', DB: db }
    const res = await admin.request('/admin/ai-summaries', { method: 'GET' }, env as any)
    expect(res.status).toBe(403)
    const body = await res.json() as any
    expect(body.error).toBe('not available')
  })

  it('returns 200 with { job: "ai-summaries", result: { skipped: "off" } } when DEBUG="true" and AI_PROVIDER="off"', async () => {
    const db = makeTestDb()
    const env = { ...BASE_ENV, AI_PROVIDER: 'off', DEBUG: 'true', DB: db }
    const res = await admin.request('/admin/ai-summaries', { method: 'GET' }, env as any)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.job).toBe('ai-summaries')
    expect(body.result).toEqual({ skipped: 'off' })
  })

  it('also responds to POST when DEBUG="true" and AI_PROVIDER="off"', async () => {
    const db = makeTestDb()
    const env = { ...BASE_ENV, AI_PROVIDER: 'off', DEBUG: 'true', DB: db }
    const res = await admin.request('/admin/ai-summaries', { method: 'POST' }, env as any)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.job).toBe('ai-summaries')
    expect(body.result).toEqual({ skipped: 'off' })
  })
})
