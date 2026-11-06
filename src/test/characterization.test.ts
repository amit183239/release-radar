/**
 * Characterization tests — pin CURRENT behavior of the feed/fan-out/entity
 * primitives before the v1-TODOs refactors (Tasks 4, 7, 11, 12, 14, 15).
 * Deliberately NOT pinned (changed on purpose later): createFollow's ref
 * overwrite on re-follow (Task 15) and milestone/query follow-backfill (Tasks 11/12).
 */
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity, upsertRelease, upsertNote } from '../lib/queries'
import { createFollow } from '../lib/follows'
import { recordShipEvent, fanOutShip, backfillFollowFeed } from '../lib/events'

const REPO = 'o/r'
const NOW = Math.floor(Date.now() / 1000)

async function seedShip(
  db: D1Database,
  o: { app?: string; pr?: number; deployedAt?: number; labels?: string[]; closes?: number[]; ref?: string } = {}
) {
  const app = o.app ?? 'checkout'
  const pr = o.pr ?? 10
  const deployedAt = o.deployedAt ?? NOW - 86_400
  const releaseId = await upsertRelease(db, {
    app,
    ref: o.ref ?? `sha-${app}-${pr}-${deployedAt}`,
    tag: `${app}-v1-production`,
    deployedAt,
    baseRef: null,
    divergent: false,
  })
  await upsertEntity(db, {
    repo: REPO,
    kind: 'pr',
    number: pr,
    title: `PR ${pr}`,
    state: 'MERGED',
    author: 'dev',
    labels: o.labels ?? ['bug'],
    closes: o.closes ?? [5],
    updatedAt: deployedAt,
    url: `https://github.com/o/r/pull/${pr}`,
  })
  await upsertNote(db, { releaseId, app, prNumber: pr, noteTechnical: `Note for ${pr}`, copySource: 'fallback' })
  const eventId = await recordShipEvent(db, { app, releaseId, prNumber: pr })
  return { releaseId, eventId, deployedAt }
}

describe('characterization: upsertEntity', () => {
  it('round-trips and overwrites mutable fields on conflict', async () => {
    const db = makeTestDb()
    const base = {
      repo: REPO, kind: 'issue' as const, number: 92, author: null, closes: [], url: 'https://github.com/o/r/issues/92',
    }
    await upsertEntity(db, { ...base, title: 'Old', state: 'OPEN', labels: ['bug'], updatedAt: 100, milestone: 'Q4' })
    await upsertEntity(db, { ...base, title: 'New', state: 'CLOSED', labels: [], updatedAt: 200, milestone: null })
    const row = await db
      .prepare('SELECT title, state, labels_json, updated_at, milestone, last_meaningful_activity_at FROM entities WHERE repo = ? AND kind = ? AND number = ?')
      .bind(REPO, 'issue', 92)
      .first<{ title: string; state: string; labels_json: string; updated_at: number; milestone: string | null; last_meaningful_activity_at: number }>()
    expect(row).toMatchObject({ title: 'New', state: 'CLOSED', labels_json: '[]', updated_at: 200, milestone: null })
    // lma is written on INSERT only; an UPDATE without activity leaves it.
    expect(row!.last_meaningful_activity_at).toBe(100)
    const n = await db.prepare('SELECT COUNT(*) AS n FROM entities').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })
})

describe('characterization: createFollow', () => {
  it('is idempotent on (user, type, ref) and returns the same id', async () => {
    const db = makeTestDb()
    const a = await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    const b = await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    expect(b).toBe(a)
    const n = await db.prepare('SELECT COUNT(*) AS n FROM follows').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('re-follow un-archives', async () => {
    const db = makeTestDb()
    const id = await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    await db.prepare('UPDATE follows SET archived = 1 WHERE id = ?').bind(id).run()
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    const row = await db.prepare('SELECT archived FROM follows WHERE id = ?').bind(id).first<{ archived: number }>()
    expect(row!.archived).toBe(0)
  })
})

describe('characterization: fanOutShip', () => {
  it('fans out one row per follower with the highest-priority match, idempotently', async () => {
    const db = makeTestDb()
    const { eventId } = await seedShip(db)
    await createFollow(db, { userId: 'uA', targetType: 'pr', targetRef: '10' })
    await createFollow(db, { userId: 'uA', targetType: 'app', targetRef: 'checkout' })
    await createFollow(db, { userId: 'uB', targetType: 'label', targetRef: 'bug' })
    await createFollow(db, { userId: 'uC', targetType: 'issue', targetRef: '5' })
    await createFollow(db, { userId: 'uD', targetType: 'app', targetRef: 'checkout' })
    await createFollow(db, { userId: 'uE', targetType: 'app', targetRef: 'other' })

    const params = { eventId, app: 'checkout', prNumber: 10, closesIssues: [5], prLabels: ['bug'] }
    expect(await fanOutShip(db, params)).toBe(4)
    expect(await fanOutShip(db, params)).toBe(0) // re-scan never re-alerts

    const { results } = await db
      .prepare('SELECT user_id, matched_type, matched_ref, read_at FROM feed ORDER BY user_id')
      .all<{ user_id: string; matched_type: string; matched_ref: string; read_at: number | null }>()
    expect(results).toEqual([
      { user_id: 'uA', matched_type: 'pr', matched_ref: '10', read_at: null },
      { user_id: 'uB', matched_type: 'label', matched_ref: 'bug', read_at: null },
      { user_id: 'uC', matched_type: 'issue', matched_ref: '5', read_at: null },
      { user_id: 'uD', matched_type: 'app', matched_ref: 'checkout', read_at: null },
    ])
  })

  it('skips archived follows', async () => {
    const db = makeTestDb()
    const { eventId } = await seedShip(db)
    const id = await createFollow(db, { userId: 'uA', targetType: 'app', targetRef: 'checkout' })
    await db.prepare('UPDATE follows SET archived = 1 WHERE id = ?').bind(id).run()
    expect(await fanOutShip(db, { eventId, app: 'checkout', prNumber: 10, closesIssues: [5], prLabels: ['bug'] })).toBe(0)
  })

  it('returns 0 with no followers', async () => {
    const db = makeTestDb()
    const { eventId } = await seedShip(db)
    expect(await fanOutShip(db, { eventId, app: 'checkout', prNumber: 10, closesIssues: [], prLabels: [] })).toBe(0)
  })
})

describe('characterization: backfillFollowFeed', () => {
  const cases: Array<[string, string]> = [
    ['app', 'checkout'],
    ['pr', '10'],
    ['label', 'bug'],
    ['issue', '5'],
  ]
  for (const [type, ref] of cases) {
    it(`seeds a READ, deploy-dated row for a ${type} follow within 7 days`, async () => {
      const db = makeTestDb()
      const { deployedAt } = await seedShip(db)
      expect(await backfillFollowFeed(db, 'u1', REPO, type, ref)).toBe(1)
      const row = await db
        .prepare('SELECT matched_type, matched_ref, read_at, created_at FROM feed WHERE user_id = ?')
        .bind('u1')
        .first<{ matched_type: string; matched_ref: string; read_at: number; created_at: number }>()
      expect(row).toEqual({ matched_type: type, matched_ref: ref, read_at: deployedAt, created_at: deployedAt })
      // Idempotent per (user, event).
      expect(await backfillFollowFeed(db, 'u1', REPO, type, ref)).toBe(0)
    })
  }

  it('ignores ships older than 7 days', async () => {
    const db = makeTestDb()
    await seedShip(db, { deployedAt: NOW - 10 * 86_400 })
    expect(await backfillFollowFeed(db, 'u1', REPO, 'app', 'checkout')).toBe(0)
  })

  it('does not match a label/issue the PR does not carry', async () => {
    const db = makeTestDb()
    await seedShip(db)
    expect(await backfillFollowFeed(db, 'u1', REPO, 'label', 'feature')).toBe(0)
    expect(await backfillFollowFeed(db, 'u1', REPO, 'issue', '6')).toBe(0)
  })
})
