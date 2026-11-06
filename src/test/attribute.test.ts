// Task 7: prefetchPair + attributePr (the shared poll/backfill attribution path).
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity } from '../lib/queries'
import { createFollow } from '../lib/follows'
import { prefetchPair, attributePr, type AttributeCtx } from '../jobs/attribute'
import type { AppConfig } from '../config'

const CONFIG: AppConfig = {
  owner: 'o',
  repo: 'r',
  ownerRepo: 'o/r',
  mappingPath: '.github/mapping.json',
  allowedDomains: ['example.com'],
  sharedLibBucket: 'platform',
  backfillDays: 7,
  aiProvider: 'off',
  aiModel: '',
  aiMonthlyCapCents: 0,
  customerFacingLabels: [],
  customerFacingIssueTypes: [],
  tagPattern: '{app}-v*-production',
}

const ctx = (): AttributeCtx => ({
  config: CONFIG,
  familySet: new Set(['checkout', 'billing']),
  queryFollows: [],
})

type Db = ReturnType<typeof makeTestDb>

async function seedPr(
  db: Db,
  number: number,
  extra: { closes?: number[]; labels?: string[]; files?: string[]; releaseNote?: string | null; milestone?: string | null } = {}
): Promise<void> {
  await upsertEntity(db, {
    repo: 'o/r',
    kind: 'pr',
    number,
    title: `PR ${number}`,
    state: 'MERGED',
    author: 'dev',
    labels: extra.labels ?? [],
    closes: extra.closes ?? [],
    updatedAt: 1000,
    url: `https://github.com/o/r/pull/${number}`,
    files: extra.files ?? null,
    releaseNote: extra.releaseNote ?? null,
    milestone: extra.milestone ?? null,
  })
}

async function seedIssue(
  db: Db,
  number: number,
  extra: { labels?: string[]; issueType?: string | null; milestone?: string | null } = {}
): Promise<void> {
  await upsertEntity(db, {
    repo: 'o/r',
    kind: 'issue',
    number,
    title: `Issue ${number}`,
    state: 'OPEN',
    author: null,
    labels: extra.labels ?? [],
    closes: [],
    updatedAt: 1000,
    url: `https://github.com/o/r/issues/${number}`,
    milestone: extra.milestone ?? null,
    issueType: extra.issueType ?? null,
  })
}

async function count(db: Db, sql: string, ...args: unknown[]): Promise<number> {
  const r = await db.prepare(sql).bind(...args).first<{ n: number }>()
  return r?.n ?? 0
}

describe('prefetchPair', () => {
  it('loads the cached PRs and the union of their closed issues', async () => {
    const db = makeTestDb()
    await seedPr(db, 10, { closes: [1, 2] })
    await seedPr(db, 11, { closes: [2, 3] })
    await seedIssue(db, 2, { labels: ['bug'] })
    const pre = await prefetchPair(db, 'o/r', [10, 11, 99])
    expect([...pre.prs.keys()].sort((a, b) => a - b)).toEqual([10, 11])
    expect([...pre.issues.keys()]).toEqual([2])
  })

  it('returns empty maps for an empty PR list', async () => {
    const db = makeTestDb()
    const pre = await prefetchPair(db, 'o/r', [])
    expect(pre.prs.size).toBe(0)
    expect(pre.issues.size).toBe(0)
  })
})

describe('attributePr', () => {
  it('skips a PR whose own files scope to a different app (no note, no event)', async () => {
    const db = makeTestDb()
    await seedPr(db, 20, { files: ['apps/billing/backend/x.ts'] })
    const pre = await prefetchPair(db, 'o/r', [20])
    const r = await attributePr(db, ctx(), pre, {
      releaseId: 'rel-1', app: 'checkout', prNumber: 20, title: 'title 20', fanOut: true,
    })
    expect(r).toEqual({ attributed: false, feedItemsCreated: 0 })
    expect(await count(db, 'SELECT COUNT(*) AS n FROM notes')).toBe(0)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM events')).toBe(0)
  })

  it('uses the curated release note (human) and falls back to the squash title', async () => {
    const db = makeTestDb()
    await seedPr(db, 21, { releaseNote: 'Curated copy' })
    // PR 22 is not in the entity cache -> fallback title, unknown files -> kept.
    const pre = await prefetchPair(db, 'o/r', [21, 22])
    await attributePr(db, ctx(), pre, { releaseId: 'rel-1', app: 'checkout', prNumber: 21, title: 'title 21', fanOut: true })
    await attributePr(db, ctx(), pre, { releaseId: 'rel-1', app: 'checkout', prNumber: 22, title: 'title 22', fanOut: true })
    const rows = await db
      .prepare('SELECT pr_number, note_technical, copy_source FROM notes ORDER BY pr_number')
      .bind()
      .all<{ pr_number: number; note_technical: string; copy_source: string }>()
    expect(rows.results).toEqual([
      { pr_number: 21, note_technical: 'Curated copy', copy_source: 'human' },
      { pr_number: 22, note_technical: 'title 22', copy_source: 'fallback' },
    ])
  })

  it('fanOut:true creates feed rows; fanOut:false records the ship event only', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    const pre = await prefetchPair(db, 'o/r', [23, 24])
    const a = await attributePr(db, ctx(), pre, { releaseId: 'rel-a', app: 'checkout', prNumber: 23, title: 't23', fanOut: true })
    const b = await attributePr(db, ctx(), pre, { releaseId: 'rel-b', app: 'checkout', prNumber: 24, title: 't24', fanOut: false })
    expect(a).toEqual({ attributed: true, feedItemsCreated: 1 })
    expect(b).toEqual({ attributed: true, feedItemsCreated: 0 })
    expect(await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind = 'shipped'")).toBe(2)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM feed WHERE user_id = ?', 'u1')).toBe(1)
  })
})

describe('attributePr — customer_facing via closed issues (Task 9)', () => {
  async function cf(db: Db, prNumber: number): Promise<number> {
    const r = await db
      .prepare('SELECT customer_facing AS n FROM notes WHERE pr_number = ?')
      .bind(prNumber)
      .first<{ n: number }>()
    return r?.n ?? -1
  }

  it('a closed issue label marks the PR customer-facing, but does NOT drive label fan-out', async () => {
    const db = makeTestDb()
    await seedIssue(db, 9, { labels: ['customer-facing'] })
    await seedPr(db, 30, { closes: [9], labels: ['backend'] })
    // u1 follows the ISSUE's label; label fan-out must only use the PR's own labels.
    await createFollow(db, { userId: 'u1', targetType: 'label', targetRef: 'customer-facing' })
    const pre = await prefetchPair(db, 'o/r', [30])
    const c: AttributeCtx = {
      ...ctx(),
      config: { ...CONFIG, customerFacingLabels: ['customer-facing'] },
    }
    const r = await attributePr(db, c, pre, { releaseId: 'rel-1', app: 'checkout', prNumber: 30, title: 't', fanOut: true })
    expect(r.feedItemsCreated).toBe(0)
    expect(await cf(db, 30)).toBe(1)
  })

  it('a closed issue type matching CUSTOMER_FACING_ISSUE_TYPES marks it customer-facing', async () => {
    const db = makeTestDb()
    await seedIssue(db, 11, { issueType: 'Bug' })
    await seedPr(db, 31, { closes: [11] })
    const pre = await prefetchPair(db, 'o/r', [31])
    const c: AttributeCtx = { ...ctx(), config: { ...CONFIG, customerFacingIssueTypes: ['bug'] } }
    await attributePr(db, c, pre, { releaseId: 'rel-1', app: 'checkout', prNumber: 31, title: 't', fanOut: true })
    expect(await cf(db, 31)).toBe(1)
  })

  it('a closed issue missing from the entity cache contributes nothing (fail-closed)', async () => {
    const db = makeTestDb()
    await seedPr(db, 32, { closes: [404] })
    const pre = await prefetchPair(db, 'o/r', [32])
    const c: AttributeCtx = {
      ...ctx(),
      config: { ...CONFIG, customerFacingLabels: ['customer-facing'], customerFacingIssueTypes: ['bug'] },
    }
    await attributePr(db, c, pre, { releaseId: 'rel-1', app: 'checkout', prNumber: 32, title: 't', fanOut: true })
    expect(await cf(db, 32)).toBe(0)
  })
})
