// Task 11: query follows across fan-out, follow-backfill, and read time.
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertRelease, upsertNote, upsertEntity } from '../lib/queries'
import { createFollow } from '../lib/follows'
import { nowSeconds } from '../lib/helpers'
import {
  MATCH_PRIORITY,
  recordShipEvent,
  fanOutShip,
  listQueryFollows,
  backfillFollowFeed,
  listFeed,
} from '../lib/events'

type Db = ReturnType<typeof makeTestDb>

/** One shipped PR #50 on checkout with the given stored note. */
async function ship(db: Db, note: string): Promise<{ releaseId: string; eventId: string }> {
  const releaseId = await upsertRelease(db, {
    app: 'checkout', ref: 'sha50', tag: 'checkout-v50-production',
    deployedAt: nowSeconds() - 60, baseRef: 'sha49', divergent: false,
  })
  await upsertNote(db, { releaseId, app: 'checkout', prNumber: 50, noteTechnical: note, copySource: 'fallback' })
  await upsertEntity(db, {
    repo: 'o/r', kind: 'pr', number: 50, title: note, state: 'MERGED', author: 'dev',
    labels: ['bug'], closes: [], updatedAt: 1000, url: 'u50',
  })
  const eventId = await recordShipEvent(db, { app: 'checkout', releaseId, prNumber: 50 })
  return { releaseId, eventId }
}

describe('MATCH_PRIORITY', () => {
  it('orders pr > issue > milestone > label > query > app', () => {
    const order = Object.entries(MATCH_PRIORITY).sort((a, b) => a[1] - b[1]).map(([k]) => k)
    expect(order).toEqual(['pr', 'issue', 'milestone', 'label', 'query', 'app'])
  })
})

describe('upsertNote returns the STORED note_technical', () => {
  it('returns the incoming text normally, but the kept human note after the never-downgrade gate', async () => {
    const db = makeTestDb()
    const a = await upsertNote(db, { releaseId: 'r1', app: 'checkout', prNumber: 7, noteTechnical: 'Curated', copySource: 'human' })
    expect(a).toEqual({ noteTechnical: 'Curated' })
    const b = await upsertNote(db, { releaseId: 'r1', app: 'checkout', prNumber: 7, noteTechnical: 'fallback title', copySource: 'fallback' })
    expect(b).toEqual({ noteTechnical: 'Curated' })
  })
})

describe('query follows — fan-out', () => {
  it('a matching query follow wins over app but loses to label', async () => {
    const db = makeTestDb()
    const { eventId } = await ship(db, 'Fix webhook retry storm')
    await createFollow(db, { userId: 'uq', targetType: 'query', targetRef: 'retry' })
    await createFollow(db, { userId: 'uq', targetType: 'app', targetRef: 'checkout' })
    await createFollow(db, { userId: 'ul', targetType: 'query', targetRef: 'retry' })
    await createFollow(db, { userId: 'ul', targetType: 'label', targetRef: 'bug' })
    await createFollow(db, { userId: 'un', targetType: 'query', targetRef: 'nomatch' })

    const queryFollows = await listQueryFollows(db)
    expect(queryFollows.length).toBe(3)
    const created = await fanOutShip(db, {
      eventId, app: 'checkout', prNumber: 50, closesIssues: [], prLabels: ['bug'],
      noteTechnical: 'Fix webhook retry storm', queryFollows,
    })
    expect(created).toBe(2)
    const rows = await db
      .prepare('SELECT user_id, matched_type, matched_ref FROM feed ORDER BY user_id')
      .bind()
      .all<{ user_id: string; matched_type: string; matched_ref: string }>()
    expect(rows.results).toEqual([
      { user_id: 'ul', matched_type: 'label', matched_ref: 'bug' },
      { user_id: 'uq', matched_type: 'query', matched_ref: 'retry' },
    ])
  })
})

describe('query follows — follow-backfill', () => {
  it('seeds a matching shipped note (escaped LIKE) and ignores non-shipped events', async () => {
    const db = makeTestDb()
    const { releaseId } = await ship(db, 'Fix webhook retry storm')
    // A non-shipped event on the same release/PR must never be backfilled.
    await db
      .prepare(
        `INSERT INTO events (id, kind, app, release_id, pr_number, created_at)
         VALUES (?, 'activity', NULL, ?, 50, ?)`
      )
      .bind('ev-activity', releaseId, nowSeconds())
      .run()
    expect(await backfillFollowFeed(db, 'u1', 'o/r', 'query', 'WEBHOOK retry')).toBe(1)
    expect(await backfillFollowFeed(db, 'u2', 'o/r', 'query', '50%')).toBe(0)
    expect(await backfillFollowFeed(db, 'u3', 'o/r', 'pr', '50')).toBe(1)
  })
})

describe('query follows — read time (listFeed matches)', () => {
  it('reports the query match alongside other current follows', async () => {
    const db = makeTestDb()
    const { eventId } = await ship(db, 'Fix webhook retry storm')
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    await fanOutShip(db, { eventId, app: 'checkout', prNumber: 50, closesIssues: [], prLabels: ['bug'] })
    await createFollow(db, { userId: 'u1', targetType: 'query', targetRef: 'retry' })
    const items = await listFeed(db, 'u1', 'o/r')
    expect(items.length).toBe(1)
    expect(items[0]!.matches.map(({ type, ref }) => ({ type, ref }))).toEqual([
      { type: 'query', ref: 'retry' },
      { type: 'app', ref: 'checkout' },
    ])
  })
})

describe('priority renumber — single follower matching many ways', () => {
  async function winnerFor(follows: Array<[string, string]>, closes: number[]): Promise<string> {
    const db = makeTestDb()
    const { eventId } = await ship(db, 'Fix webhook retry storm')
    for (const [t, r] of follows) await createFollow(db, { userId: 'u', targetType: t as never, targetRef: r })
    await fanOutShip(db, {
      eventId, app: 'checkout', prNumber: 50, closesIssues: closes, prLabels: ['bug'],
      noteTechnical: 'Fix webhook retry storm', queryFollows: await listQueryFollows(db),
    })
    const row = await db.prepare('SELECT matched_type FROM feed WHERE user_id = ?').bind('u').first<{ matched_type: string }>()
    return row!.matched_type
  }
  it('issue + label + query + app -> issue', async () => {
    expect(await winnerFor([['issue', '9'], ['label', 'bug'], ['query', 'retry'], ['app', 'checkout']], [9])).toBe('issue')
  })
  it('label + query + app -> label', async () => {
    expect(await winnerFor([['label', 'bug'], ['query', 'retry'], ['app', 'checkout']], [])).toBe('label')
  })
  it('label vs query -> label', async () => {
    expect(await winnerFor([['label', 'bug'], ['query', 'retry']], [])).toBe('label')
  })
  it('query vs app -> query', async () => {
    expect(await winnerFor([['query', 'retry'], ['app', 'checkout']], [])).toBe('query')
  })
})
