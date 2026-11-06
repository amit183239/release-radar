import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { listPersonaDigest } from '../lib/events'
import { upsertSummary } from '../lib/queries'

async function rel(db: any, id: string, app: string, tag: string, deployedAt: number) {
  await db
    .prepare(
      'INSERT INTO releases (id, app, ref, tag, deployed_at, divergent, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .bind(id, app, `sha-${id}`, tag, deployedAt, 0, deployedAt)
    .run()
}

async function note(
  db: any,
  releaseId: string,
  pr: number,
  tech: string,
  cf: number,
  url: string,
) {
  await db
    .prepare(
      'INSERT INTO notes (id, release_id, app, pr_number, note_technical, customer_facing, url) VALUES (?,?,?,?,?,?,?)',
    )
    .bind(`n-${releaseId}-${pr}`, releaseId, 'app', pr, tech, cf, url)
    .run()
}

const ai = (
  db: any,
  releaseId: string,
  pr: number,
  role: 'developer' | 'cx',
  headline: string,
  now: number,
) =>
  upsertSummary(db, {
    releaseId,
    prNumber: pr,
    role,
    result: { headline, body: null, costCents: 1 },
    inputHash: `h${pr}${role}`,
    now,
  })

describe('listPersonaDigest', () => {
  it('returns only ai rows for the role, newest deploy first, with release+note fields joined', async () => {
    const db = makeTestDb()

    // two releases: r-edge deployed_at=300, r-aff deployed_at=500
    await rel(db, 'r-edge', 'platform', 'platform-v2.2.0-production', 300)
    await rel(db, 'r-aff', 'billing', 'billing-v2.2.0-production', 500)

    // notes: one for pr=172 (r-edge), one for pr=154 (r-aff)
    await note(db, 'r-edge', 172, 'consent banner fix', 1, 'u172')
    await note(db, 'r-aff', 154, 'billing fix', 0, 'u154')

    // cx summary for pr=154 (r-aff, deployed_at=500) — ai row
    await ai(db, 'r-aff', 154, 'cx', 'Billing summary for customers', 1)
    // cx summary for pr=172 (r-edge, deployed_at=300) — ai row
    await ai(db, 'r-edge', 172, 'cx', 'Consent banner update', 2)
    // developer summary for pr=172 (r-edge) — ai row (must be excluded from cx query)
    await ai(db, 'r-edge', 172, 'developer', 'Fixes consent banner flicker', 1)
    // a fallback cx row (must be excluded — source != 'ai'):
    // insert directly with source='fallback' to avoid never-downgrade no-op
    await db
      .prepare(
        `INSERT INTO persona_summaries (id, release_id, pr_number, role, headline, body, source, input_hash, cost_cents, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        'ps-fallback-aff-154',
        'r-aff',
        154,
        'cx',
        'fallback headline',
        null,
        'fallback',
        'z-fallback',
        0,
        3,
        3,
      )
      .run()
      .catch(() => {
        /* no-op if UNIQUE conflict */
      })

    const cx = await listPersonaDigest(db as any, 'cx', 100)
    // r-aff (deployed_at=500) before r-edge (deployed_at=300)
    expect(cx.map((r) => r.pr_number)).toEqual([154, 172])
    expect(cx.every((r) => r.source === 'ai')).toBe(true)
    expect(cx.find((r) => r.pr_number === 172)).toMatchObject({
      app: 'platform',
      tag: 'platform-v2.2.0-production',
      note_technical: 'consent banner fix',
      url: 'u172',
    })

    const dev = await listPersonaDigest(db as any, 'developer', 100)
    expect(dev.map((r) => r.pr_number)).toEqual([172])
    expect(dev[0].headline).toBe('Fixes consent banner flicker')
  })

  it('a summary with no matching note still returns (LEFT JOIN), note fields null', async () => {
    const db = makeTestDb()
    await rel(db, 'r1', 'checkout', 'checkout-v2.1.0-production', 100)
    await ai(db, 'r1', 194, 'cx', 'Cart totals correct with two discounts', 1)

    const rows = await listPersonaDigest(db as any, 'cx', 100)
    expect(rows).toHaveLength(1)
    expect(rows[0].pr_number).toBe(194)
    expect(rows[0].note_technical).toBeNull()
    expect(rows[0].url).toBeNull()
  })

  it('respects limit', async () => {
    const db = makeTestDb()
    for (let i = 1; i <= 5; i++) {
      await rel(db, `r${i}`, 'search', `t${i}`, i * 10)
      await ai(db, `r${i}`, i, 'developer', `h${i}`, i)
    }
    expect(await listPersonaDigest(db as any, 'developer', 3)).toHaveLength(3)
  })
})
