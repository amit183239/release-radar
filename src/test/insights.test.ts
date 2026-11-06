// src/test/insights.test.ts
import { describe, it, expect } from 'vitest'
import { computeInsights } from '../lib/insights'

// Minimal in-memory D1 stub: supports the two prepared queries insights.ts runs.
// We assert on the SHAPE + that role card sets differ; exact SQL is exercised by
// the Miniflare integration test (follow-up). Here we inject a fake db.
function fakeDb(rows: { notes: any[]; releases: any[] }) {
  return {
    prepare(sql: string) {
      const q = { _sql: sql, _binds: [] as any[],
        bind(...b: any[]) { this._binds = b; return this },
        async all() {
          if (/FROM releases/.test(sql)) return { results: rows.releases }
          return { results: rows.notes }
        },
        async first() { return rows.releases[0] ?? null },
      }
      return q
    },
  } as any
}

const NOW = 1_700_000_000
const within = NOW - 5 * 86400

describe('computeInsights', () => {
  const db = fakeDb({
    releases: [
      { id: 'r1', app: 'platform', tag: 'platform-v1.4.0-production', deployed_at: within, divergent: 0 },
      { id: 'r2', app: 'billing', tag: 'billing-v1.1.0-production', deployed_at: within, divergent: 1 },
    ],
    notes: [
      { app: 'platform', pr_number: 99, customer_facing: 1, copy_source: 'human', customer_source: 'ai', note_customer: 'Consent banner', note_technical: 'x', url: 'u99', labels_json: '["feature","customer-facing"]', closes_json: '[92]', deployed_at: within },
      { app: 'platform', pr_number: 100, customer_facing: 1, copy_source: 'human', customer_source: null, note_customer: 'Dedup fix', note_technical: 'y', url: 'u100', labels_json: '["bug"]', closes_json: '[]', deployed_at: within },
      { app: 'billing', pr_number: 96, customer_facing: 1, copy_source: 'human', customer_source: null, note_customer: 'Payout webhook', note_technical: 'z', url: 'u96', labels_json: '["feature"]', closes_json: '[]', deployed_at: within },
    ],
  })

  it('CX cards include customer_facing count and issues_resolved', async () => {
    const r = await computeInsights(db, { repo: 'o/r', roleKey: 'cx', windowDays: 30, now: NOW })
    const card = (k: string) => r.cards.find((c) => c.key === k)?.value
    expect(card('customer_facing')).toBe(3)
    expect(card('issues_resolved')).toBe(1)   // one closes_json with #92
    expect(r.highlights.length).toBeGreaterThan(0)
  })

  it('Support cards count bugs vs the Sales feature count (roles differ)', async () => {
    const support = await computeInsights(db, { repo: 'o/r', roleKey: 'support', windowDays: 30, now: NOW })
    const sales = await computeInsights(db, { repo: 'o/r', roleKey: 'sales', windowDays: 30, now: NOW })
    expect(support.cards.find((c) => c.key === 'bugs')?.value).toBe(1)
    expect(sales.cards.find((c) => c.key === 'features')?.value).toBe(2)
  })

  it('developer counts releases + divergent', async () => {
    const r = await computeInsights(db, { repo: 'o/r', roleKey: 'developer', windowDays: 30, now: NOW })
    expect(r.cards.find((c) => c.key === 'releases')?.value).toBe(2)
    expect(r.cards.find((c) => c.key === 'divergent')?.value).toBe(1)
  })

  it('pm prs_by_app counts distinct apps, not total PRs', async () => {
    const r = await computeInsights(db, { repo: 'o/r', roleKey: 'pm', windowDays: 30, now: NOW })
    expect(r.cards.find((c) => c.key === 'prs_by_app')?.value).toBe(2)
  })

  it('series has one bucket per window day with PRs on the deploy day', async () => {
    const r = await computeInsights(db, { repo: 'o/r', roleKey: 'developer', windowDays: 30, now: NOW })
    expect(r.series.length).toBe(30)
    // all 3 notes + 2 releases landed on `within` (5 days ago) → summed across the series.
    expect(r.series.reduce((s, d) => s + d.prs, 0)).toBe(3)
    expect(r.series.reduce((s, d) => s + d.releases, 0)).toBe(2)
  })

  it('major = divergent releases + breaking/feature PRs (not routine fixes)', async () => {
    const r = await computeInsights(db, { repo: 'o/r', roleKey: 'developer', windowDays: 30, now: NOW })
    const reasons = r.major.map((m) => m.reason).sort()
    // r2 divergent + #99 feature + #96 feature; #100 (bug only) excluded.
    expect(reasons).toEqual(['divergent', 'feature', 'feature'])
    expect(r.major.find((m) => m.reason === 'divergent')?.title).toBe('billing-v1.1.0-production')
  })
})
