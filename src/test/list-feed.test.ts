/**
 * listFeed characterization (Task 5). Asserts with toMatchObject so later tasks
 * that ADD fields (payload, customer_ref/ticket_ref on matches) don't break it.
 */
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity, upsertRelease, upsertNote } from '../lib/queries'
import { createFollow } from '../lib/follows'
import { recordShipEvent, fanOutShip, listFeed } from '../lib/events'

const REPO = 'o/r'
const NOW = Math.floor(Date.now() / 1000)

async function ship(db: D1Database, pr: number, opts: { app?: string; labels?: string[]; closes?: number[] } = {}) {
  const app = opts.app ?? 'checkout'
  const releaseId = await upsertRelease(db, {
    app, ref: `sha-${pr}`, tag: `${app}-v${pr}-production`, deployedAt: NOW - 3600, baseRef: null, divergent: false,
  })
  await upsertEntity(db, {
    repo: REPO, kind: 'pr', number: pr, title: `PR ${pr}`, state: 'MERGED', author: 'dev',
    labels: opts.labels ?? ['bug'], closes: opts.closes ?? [5], updatedAt: NOW - 7200, url: `https://github.com/o/r/pull/${pr}`,
  })
  await upsertNote(db, {
    releaseId, app, prNumber: pr, noteTechnical: `Note for ${pr}`, copySource: 'fallback', url: `https://github.com/o/r/pull/${pr}`,
  })
  const eventId = await recordShipEvent(db, { app, releaseId, prNumber: pr })
  await fanOutShip(db, { eventId, app, prNumber: pr, closesIssues: opts.closes ?? [5], prLabels: opts.labels ?? ['bug'] })
  return { releaseId, eventId }
}

describe('listFeed', () => {
  it('returns the ship with note/tag and ALL current matches, priority-ordered', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'label', targetRef: 'bug' })
    await createFollow(db, { userId: 'u1', targetType: 'pr', targetRef: '10' })
    await ship(db, 10)
    const items = await listFeed(db, 'u1', REPO)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'shipped',
      app: 'checkout',
      pr_number: 10,
      tag: 'checkout-v10-production',
      note_technical: 'Note for 10',
      url: 'https://github.com/o/r/pull/10',
      read_at: null,
      matched_type: 'pr',
      matched_ref: '10',
    })
    expect(items[0]!.matches).toMatchObject([
      { type: 'pr', ref: '10' },
      { type: 'label', ref: 'bug' },
    ])
    // Raw join columns never leak out.
    expect(items[0]).not.toHaveProperty('labels_json')
    expect(items[0]).not.toHaveProperty('closes_json')
  })

  it('falls back to the stored fan-out match when the follow is gone', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '5' })
    await ship(db, 11)
    await db.prepare('DELETE FROM follows WHERE user_id = ?').bind('u1').run()
    const [item] = await listFeed(db, 'u1', REPO)
    expect(item).toMatchObject({ matched_type: 'issue', matched_ref: '5' })
    expect(item!.matches).toMatchObject([{ type: 'issue', ref: '5' }])
  })

  it('unreadOnly hides read items', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    await ship(db, 12)
    await db.prepare('UPDATE feed SET read_at = ? WHERE user_id = ?').bind(NOW, 'u1').run()
    expect(await listFeed(db, 'u1', REPO, { unreadOnly: true })).toHaveLength(0)
    expect(await listFeed(db, 'u1', REPO)).toHaveLength(1)
  })

  it('orders newest-first and honors limit; scoped to the user', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
    await createFollow(db, { userId: 'u2', targetType: 'app', targetRef: 'checkout' })
    const a = await ship(db, 13)
    const b = await ship(db, 14)
    await db.prepare('UPDATE feed SET created_at = ? WHERE event_id = ?').bind(100, a.eventId).run()
    await db.prepare('UPDATE feed SET created_at = ? WHERE event_id = ?').bind(200, b.eventId).run()
    const items = await listFeed(db, 'u1', REPO)
    expect(items.map((i) => i.pr_number)).toEqual([14, 13])
    expect(await listFeed(db, 'u1', REPO, { limit: 1 })).toHaveLength(1)
    expect(await listFeed(db, 'nobody', REPO)).toHaveLength(0)
  })
})
