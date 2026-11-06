// Task 12: milestone follows — PR milestone OR any closed issue's milestone.
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertRelease, upsertNote, upsertEntity } from '../lib/queries'
import { createFollow } from '../lib/follows'
import { nowSeconds } from '../lib/helpers'
import { recordShipEvent, fanOutShip, backfillFollowFeed, listFeed } from '../lib/events'
import { prefetchPair, attributePr, type AttributeCtx } from '../jobs/attribute'
import type { AppConfig } from '../config'

type Db = ReturnType<typeof makeTestDb>

const CONFIG: AppConfig = {
  owner: 'o', repo: 'r', ownerRepo: 'o/r', mappingPath: '.github/mapping.json',
  allowedDomains: ['example.com'], sharedLibBucket: 'platform', backfillDays: 7,
  aiProvider: 'off', aiModel: '', aiMonthlyCapCents: 0,
  customerFacingLabels: [], customerFacingIssueTypes: [], tagPattern: '{app}-v*-production',
}

async function seedIssue(db: Db, number: number, milestone: string | null): Promise<void> {
  await upsertEntity(db, {
    repo: 'o/r', kind: 'issue', number, title: `Issue ${number}`, state: 'CLOSED', author: null,
    labels: [], closes: [], updatedAt: 1000, url: `i${number}`, milestone,
  })
}

async function seedPr(db: Db, number: number, opts: { milestone?: string | null; closes?: number[]; labels?: string[] } = {}): Promise<void> {
  await upsertEntity(db, {
    repo: 'o/r', kind: 'pr', number, title: `PR ${number}`, state: 'MERGED', author: 'dev',
    labels: opts.labels ?? [], closes: opts.closes ?? [], updatedAt: 1000, url: `u${number}`,
    milestone: opts.milestone ?? null,
  })
}

/** Ship PR `n` on checkout and return ids. */
async function shipPr(db: Db, n: number): Promise<{ releaseId: string; eventId: string }> {
  const releaseId = await upsertRelease(db, {
    app: 'checkout', ref: `sha${n}`, tag: `checkout-v${n}-production`,
    deployedAt: nowSeconds() - 60, baseRef: `sha${n - 1}`, divergent: false,
  })
  await upsertNote(db, { releaseId, app: 'checkout', prNumber: n, noteTechnical: `note ${n}`, copySource: 'fallback' })
  const eventId = await recordShipEvent(db, { app: 'checkout', releaseId, prNumber: n })
  return { releaseId, eventId }
}

describe('milestone follows — fan-out via attributePr', () => {
  it('matches the PR milestone and a closed issue milestone; milestone beats label', async () => {
    const db = makeTestDb()
    await seedIssue(db, 7, 'Q4 Checkout')
    await seedPr(db, 60, { milestone: 'Q3 Infra', closes: [7], labels: ['bug'] })
    await createFollow(db, { userId: 'u-pr-ms', targetType: 'milestone', targetRef: 'Q3 Infra' })
    await createFollow(db, { userId: 'u-iss-ms', targetType: 'milestone', targetRef: 'Q4 Checkout' })
    await createFollow(db, { userId: 'u-iss-ms', targetType: 'label', targetRef: 'bug' })
    await createFollow(db, { userId: 'u-other', targetType: 'milestone', targetRef: 'Q4' }) // exact match only

    const ctx: AttributeCtx = { config: CONFIG, familySet: new Set(['checkout']), queryFollows: [] }
    const pre = await prefetchPair(db, 'o/r', [60])
    const r = await attributePr(db, ctx, pre, { releaseId: 'rel-60', app: 'checkout', prNumber: 60, title: 't', fanOut: true })
    expect(r.feedItemsCreated).toBe(2)
    const rows = await db
      .prepare('SELECT user_id, matched_type, matched_ref FROM feed ORDER BY user_id')
      .bind()
      .all<{ user_id: string; matched_type: string; matched_ref: string }>()
    expect(rows.results).toEqual([
      { user_id: 'u-iss-ms', matched_type: 'milestone', matched_ref: 'Q4 Checkout' },
      { user_id: 'u-pr-ms', matched_type: 'milestone', matched_ref: 'Q3 Infra' },
    ])
  })

  it('priority: issue > milestone > label for one follower', async () => {
    const db = makeTestDb()
    await seedIssue(db, 7, 'Q4 Checkout')
    await seedPr(db, 61, { milestone: 'Q3 Infra', closes: [7], labels: ['bug'] })
    for (const [t, ref] of [['issue', '7'], ['milestone', 'Q3 Infra'], ['label', 'bug']] as const) {
      await createFollow(db, { userId: 'u-all', targetType: t, targetRef: ref })
    }
    await createFollow(db, { userId: 'u-ml', targetType: 'milestone', targetRef: 'Q3 Infra' })
    await createFollow(db, { userId: 'u-ml', targetType: 'label', targetRef: 'bug' })
    const ctx: AttributeCtx = { config: CONFIG, familySet: new Set(['checkout']), queryFollows: [] }
    const pre = await prefetchPair(db, 'o/r', [61])
    await attributePr(db, ctx, pre, { releaseId: 'rel-61', app: 'checkout', prNumber: 61, title: 't', fanOut: true })
    const rows = await db
      .prepare('SELECT user_id, matched_type FROM feed ORDER BY user_id')
      .bind()
      .all<{ user_id: string; matched_type: string }>()
    expect(rows.results).toEqual([
      { user_id: 'u-all', matched_type: 'issue' },
      { user_id: 'u-ml', matched_type: 'milestone' },
    ])
  })
})

describe('milestone follows — follow-backfill', () => {
  it('seeds ships whose PR milestone or closed-issue milestone matches', async () => {
    const db = makeTestDb()
    await seedIssue(db, 8, 'Q4 Checkout')
    await seedPr(db, 70, { milestone: 'Q4 Checkout' })
    await seedPr(db, 71, { closes: [8] })
    await seedPr(db, 72, { milestone: 'Other' })
    await shipPr(db, 70)
    await shipPr(db, 71)
    await shipPr(db, 72)
    expect(await backfillFollowFeed(db, 'u1', 'o/r', 'milestone', 'Q4 Checkout')).toBe(2)
  })
})

describe('milestone follows — read time (listFeed)', () => {
  it('reports milestone matches from the PR and its closed issues, in priority order', async () => {
    const db = makeTestDb()
    await seedIssue(db, 9, 'Q4 Checkout')
    await seedPr(db, 80, { milestone: 'Q3 Infra', closes: [9], labels: ['bug'] })
    const { eventId } = await shipPr(db, 80)
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    await fanOutShip(db, { eventId, app: 'checkout', prNumber: 80, closesIssues: [9], prLabels: ['bug'] })
    await createFollow(db, { userId: 'u1', targetType: 'milestone', targetRef: 'Q4 Checkout' })
    await createFollow(db, { userId: 'u1', targetType: 'milestone', targetRef: 'Q3 Infra' })
    await createFollow(db, { userId: 'u1', targetType: 'label', targetRef: 'bug' })

    const items = await listFeed(db, 'u1', 'o/r')
    expect(items.length).toBe(1)
    const got = items[0]!.matches.map(({ type, ref }) => ({ type, ref }))
    expect(got.map((m) => m.type)).toEqual(['milestone', 'milestone', 'label', 'app'])
    expect(new Set(got.filter((m) => m.type === 'milestone').map((m) => m.ref))).toEqual(
      new Set(['Q3 Infra', 'Q4 Checkout'])
    )
    // Internal helper columns are not leaked to the API shape.
    expect(items[0]).not.toHaveProperty('pr_milestone')
    expect(items[0]).not.toHaveProperty('issue_milestones_json')
  })

  it('a feed row whose PR is not in the entity cache still lists (no milestone columns)', async () => {
    const db = makeTestDb()
    const { eventId } = await shipPr(db, 90)
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    await fanOutShip(db, { eventId, app: 'checkout', prNumber: 90, closesIssues: [], prLabels: [] })
    const items = await listFeed(db, 'u1', 'o/r')
    expect(items.map((i) => i.pr_number)).toEqual([90])
  })
})
