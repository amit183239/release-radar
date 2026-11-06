import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { runAiSummaries } from '../jobs/ai-summaries'
import { FixtureAiProvider } from './fixtures/fixture-ai-provider'

// Full env required by resolveConfig; runAiSummaries reads cap + repo from it.
const ENV = (over: any = {}) => ({
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'k',
  GITHUB_REPO: 'o/r',
  AI_MONTHLY_CAP_CENTS: '500',
  RELEASE_TAG_PATTERN: '{app}-*-production',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  BACKFILL_DAYS: '90',
  MAPPING_JSON_PATH: '.github/mapping.json',
  SHARED_LIB_BUCKET: 'platform',
  CUSTOMER_FACING_LABELS: 'customer-facing',
  ...over,
})

async function seedPr(db: any, pr: number, cf: number, mergedAt: number, opts: { releaseNote?: string; labels?: string[]; title?: string } = {}) {
  const rid = `rel-${pr}`
  await db.prepare('INSERT INTO releases (id, app, ref, tag, deployed_at, divergent, created_at) VALUES (?,?,?,?,?,?,?)').bind(rid, 'billing', `sha${pr}`, `billing-v1.${pr}.0-production`, mergedAt, 0, mergedAt).run()
  await db.prepare('INSERT INTO notes (id, release_id, app, pr_number, note_technical, customer_facing, merged_at) VALUES (?,?,?,?,?,?,?)').bind(`n-${pr}`, rid, 'billing', pr, opts.title ?? `Ship feature ${pr} now`, cf, mergedAt).run()
  await db.prepare('INSERT INTO entities (id, repo, kind, number, title, state, labels_json, closes_json, release_note, url, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(`pr-${pr}`, 'o/r', 'pr', pr, opts.title ?? `Ship feature ${pr} now`, 'MERGED', JSON.stringify(opts.labels ?? ['feature']), '[]', opts.releaseNote ?? null, `u${pr}`, mergedAt).run()
  return rid
}

describe('runAiSummaries', () => {
  it('off provider short-circuits', async () => {
    const db = makeTestDb()
    const r = await runAiSummaries({ ...ENV({ AI_PROVIDER: 'off' }), DB: db } as any)
    expect(r).toEqual({ skipped: 'off' })
  })

  it('generates dev+cx for a CF PR, dev-only for non-CF, and is idempotent on re-run', async () => {
    const db = makeTestDb()
    await seedPr(db, 1, 1, 100, { releaseNote: 'Advertisers can now bulk-invite billings' })
    await seedPr(db, 2, 0, 200, { releaseNote: 'Internal refactor of the token cache' })
    const provider = new FixtureAiProvider()
    const r1: any = await runAiSummaries({ ...ENV(), DB: db } as any, { provider })
    expect(r1.callsDeveloper).toBe(2)
    expect(r1.callsCx).toBe(1)
    const r2: any = await runAiSummaries({ ...ENV(), DB: db } as any, { provider: new FixtureAiProvider() })
    expect(r2.generated).toBe(0) // all present, same hash → nothing to do
  })

  it('thin CX input writes a fallback with zero cx calls; dev still generates', async () => {
    const db = makeTestDb()
    await seedPr(db, 3, 1, 100, { title: 'Fix typo', labels: [], releaseNote: undefined }) // score: title<4 words, no note/labels → cx below 2
    const provider = new FixtureAiProvider()
    await runAiSummaries({ ...ENV(), DB: db } as any, { provider })
    expect(provider.calls.cx).toBe(0)
    const cx = await db.prepare("SELECT source, body FROM persona_summaries WHERE pr_number=3 AND role='cx'").first<{ source: string; body: string | null }>()
    expect(cx?.source).toBe('fallback')
    expect(cx?.body).toBeNull()
  })

  it('stops at the spend cap mid-pair without regenerating the completed role', async () => {
    const db = makeTestDb()
    await seedPr(db, 4, 1, 100, { releaseNote: 'A customer benefit here' })
    // cap = 2 cents; each call costs 2 → dev consumes the cap, cx must be skipped
    const provider = new FixtureAiProvider({ costCents: 2 })
    await runAiSummaries({ ...ENV({ AI_MONTHLY_CAP_CENTS: '2' }), DB: db } as any, { provider })
    expect(provider.calls.developer).toBe(1)
    expect(provider.calls.cx).toBe(0)
    // second run: dev already ai+same-hash (no regen), cx now blocked again unless cap raised
    const p2 = new FixtureAiProvider({ costCents: 2 })
    await runAiSummaries({ ...ENV({ AI_MONTHLY_CAP_CENTS: '999' }), DB: db } as any, { provider: p2 })
    expect(p2.calls.developer).toBe(0) // hash guard: not regenerated
    expect(p2.calls.cx).toBe(1)
  })

  it('provider returns null → writes fallback with input_hash="" (retryable sentinel)', async () => {
    const db = makeTestDb()
    await seedPr(db, 10, 1, 100, { releaseNote: 'A customer benefit here' })
    // Fail every call — simulates a transient 5xx / timeout
    const failingProvider = new FixtureAiProvider({ failOn: () => true })
    await runAiSummaries({ ...ENV(), DB: db } as any, { provider: failingProvider })
    // Both roles tried but both returned null — must write '' sentinel, not real hash
    const dev = await db.prepare("SELECT source, input_hash FROM persona_summaries WHERE pr_number=10 AND role='developer'")
      .first<{ source: string; input_hash: string }>()
    const cx = await db.prepare("SELECT source, input_hash FROM persona_summaries WHERE pr_number=10 AND role='cx'")
      .first<{ source: string; input_hash: string }>()
    expect(dev?.source).toBe('fallback')
    expect(dev?.input_hash).toBe('')
    expect(cx?.source).toBe('fallback')
    expect(cx?.input_hash).toBe('')
  })

  it('error-fallback (input_hash="") is retried and upgraded on next run with working provider', async () => {
    const db = makeTestDb()
    await seedPr(db, 11, 1, 100, { releaseNote: 'A customer benefit here' })
    // First run: provider fails → both roles get fallback with ''
    const failingProvider = new FixtureAiProvider({ failOn: () => true })
    await runAiSummaries({ ...ENV(), DB: db } as any, { provider: failingProvider })
    // Confirm '' sentinel written
    const before = await db.prepare("SELECT input_hash FROM persona_summaries WHERE pr_number=11 AND role='developer'")
      .first<{ input_hash: string }>()
    expect(before?.input_hash).toBe('')
    // Second run: provider now works → must re-select the '' row and upgrade to ai
    const workingProvider = new FixtureAiProvider()
    await runAiSummaries({ ...ENV(), DB: db } as any, { provider: workingProvider })
    expect(workingProvider.calls.developer).toBe(1)
    expect(workingProvider.calls.cx).toBe(1)
    const after = await db.prepare("SELECT source, input_hash FROM persona_summaries WHERE pr_number=11 AND role='developer'")
      .first<{ source: string; input_hash: string }>()
    expect(after?.source).toBe('ai')
    expect(after?.input_hash).not.toBe('') // upgraded with a real hash
  })

  it('thin-input fallback (real hash) is NOT re-selected on rescan (permanent until input changes)', async () => {
    const db = makeTestDb()
    // PR with thin cx input (no release note, no labels, short title → cx richness below threshold)
    await seedPr(db, 12, 1, 100, { title: 'Fix typo', labels: [], releaseNote: undefined })
    const provider = new FixtureAiProvider()
    await runAiSummaries({ ...ENV(), DB: db } as any, { provider })
    // cx fallback row has a real hash (not '')
    const cx = await db.prepare("SELECT source, input_hash FROM persona_summaries WHERE pr_number=12 AND role='cx'")
      .first<{ source: string; input_hash: string }>()
    expect(cx?.source).toBe('fallback')
    expect(cx?.input_hash).not.toBe('') // real hash → permanent
    // Second run: cx must NOT be retried (hash guard)
    const p2 = new FixtureAiProvider()
    await runAiSummaries({ ...ENV(), DB: db } as any, { provider: p2 })
    expect(p2.calls.cx).toBe(0) // not re-selected
  })

  it('honors the wall-clock budget via an injected clock', async () => {
    const db = makeTestDb()
    await seedPr(db, 5, 0, 100, { releaseNote: 'x y z w' })
    await seedPr(db, 6, 0, 200, { releaseNote: 'a b c d' })
    let t = 0
    const now = () => (t += 800_000) // each read jumps past the 700s budget
    const provider = new FixtureAiProvider()
    const r: any = await runAiSummaries({ ...ENV(), DB: db } as any, { provider, now })
    expect(r.generated).toBeLessThan(2) // budget trips before draining both
  })
})
