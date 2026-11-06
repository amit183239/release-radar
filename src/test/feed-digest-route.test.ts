import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { feed } from '../routes/feed'

// Minimal env shape required by resolveConfig + requireAuth (SESSION_ENCRYPTION_KEY needed).
const ENV = (db: any) => ({
  DB: db,
  GITHUB_REPO: 'o/r',
  RELEASE_TAG_PATTERN: '{app}-*-production',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  BACKFILL_DAYS: '90',
  MAPPING_JSON_PATH: '.github/mapping.json',
  SHARED_LIB_BUCKET: 'platform',
  CUSTOMER_FACING_LABELS: 'customer-facing',
  AI_PROVIDER: 'off',
  SESSION_ENCRYPTION_KEY: 'test-key-0000000000000000000000000000',
})

describe('GET /api/feed/digest', () => {
  it('is auth-gated (401 without a session)', async () => {
    const db = makeTestDb()
    const res = await feed.request('/api/feed/digest', { method: 'GET' }, ENV(db) as any)
    expect(res.status).toBe(401)
  })
})
