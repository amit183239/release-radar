import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { fetchSummariesForFeed } from '../lib/summary-merge'
import { voiceToSummaryRole } from '../routes/feed'
import { upsertSummary } from '../lib/queries'
import { getRole } from '../lib/roles'

describe('fetchSummariesForFeed', () => {
  it('returns only the viewer-role rows, keyed by release:pr, chunking a full page', async () => {
    const db = makeTestDb()
    for (let i = 1; i <= 50; i++) {
      await upsertSummary(db, { releaseId: `r${i}`, prNumber: i, role: 'developer', result: { headline: `dev ${i}`, body: null, costCents: 1 }, inputHash: 'h', now: 1 })
      if (i % 2 === 0) await upsertSummary(db, { releaseId: `r${i}`, prNumber: i, role: 'cx', result: { headline: `cx ${i}`, body: 'why', costCents: 1 }, inputHash: 'h', now: 1 })
    }
    const keys = Array.from({ length: 50 }, (_, i) => ({ release_id: `r${i + 1}`, pr_number: i + 1 }))
    const dev = await fetchSummariesForFeed(db, 'developer', keys)
    expect(dev.size).toBe(50)
    expect(dev.get('r7:7')?.headline).toBe('dev 7')
    const cx = await fetchSummariesForFeed(db, 'cx', keys)
    expect(cx.size).toBe(25)
    expect(cx.get('r8:8')?.source).toBe('ai')
    expect(cx.get('r7:7')).toBeUndefined()
  })
  it('returns an empty map for no keys (no query)', async () => {
    const db = makeTestDb()
    expect((await fetchSummariesForFeed(db, 'developer', [])).size).toBe(0)
  })
})

describe('voiceToSummaryRole', () => {
  it('maps customer-voiced roles to cx', () => {
    expect(voiceToSummaryRole('customer')).toBe('cx')
  })
  it('maps technical-voiced roles to developer', () => {
    expect(voiceToSummaryRole('technical')).toBe('developer')
  })
  it('sales (customer voice) → cx; support (technical voice) → developer', () => {
    // sales voice is 'customer', support voice is 'technical' — verify via roles registry
    expect(voiceToSummaryRole(getRole('sales').voice)).toBe('cx')
    expect(voiceToSummaryRole(getRole('support').voice)).toBe('developer')
    expect(voiceToSummaryRole(getRole('pm').voice)).toBe('cx')
  })
})
