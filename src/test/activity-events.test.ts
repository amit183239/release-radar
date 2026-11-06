import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { recordActivityEvent, fanOutActivity, type ActivityPayload } from '../lib/events'
import { createFollow } from '../lib/follows'

const PAYLOAD: ActivityPayload = {
  entity_kind: 'issue',
  number: 92,
  title: 'Checkout fails for ACME',
  url: 'https://github.com/o/r/issues/92',
  state_from: 'OPEN',
  state_to: 'CLOSED',
}

describe('recordActivityEvent', () => {
  it('is idempotent on dedupe_key and returns the SAME id on conflict', async () => {
    const db = makeTestDb()
    const a = await recordActivityEvent(db, { entityId: 'ent-92', prNumber: null, dedupeKey: 'activity:issue:92:5000', payload: PAYLOAD })
    const b = await recordActivityEvent(db, { entityId: 'ent-92', prNumber: null, dedupeKey: 'activity:issue:92:5000', payload: PAYLOAD })
    expect(b).toBe(a)
    const rows = await db.prepare(`SELECT kind, app, release_id, pr_number, entity_id, payload_json FROM events`).all<{
      kind: string; app: string | null; release_id: string | null; pr_number: number | null; entity_id: string; payload_json: string
    }>()
    expect(rows.results).toHaveLength(1)
    const ev = rows.results[0]!
    expect(ev.kind).toBe('activity')
    expect(ev.app).toBeNull()
    expect(ev.release_id).toBeNull()
    expect(ev.pr_number).toBeNull()
    expect(ev.entity_id).toBe('ent-92')
    expect(JSON.parse(ev.payload_json)).toEqual(PAYLOAD)
  })

  it('a different dedupe key (new updatedAt) is a new event', async () => {
    const db = makeTestDb()
    const a = await recordActivityEvent(db, { entityId: 'ent-92', prNumber: null, dedupeKey: 'activity:issue:92:5000', payload: PAYLOAD })
    const b = await recordActivityEvent(db, { entityId: 'ent-92', prNumber: null, dedupeKey: 'activity:issue:92:6000', payload: PAYLOAD })
    expect(b).not.toBe(a)
  })

  it('PR activity carries pr_number', async () => {
    const db = makeTestDb()
    await recordActivityEvent(db, {
      entityId: 'ent-pr-140',
      prNumber: 140,
      dedupeKey: 'activity:pr:140:7000',
      payload: { entity_kind: 'pr', number: 140, title: 'Retry webhooks', url: null, state_from: 'OPEN', state_to: 'MERGED' },
    })
    const ev = await db.prepare(`SELECT pr_number FROM events WHERE dedupe_key = ?`).bind('activity:pr:140:7000').first<{ pr_number: number }>()
    expect(ev?.pr_number).toBe(140)
  })
})

describe('fanOutActivity', () => {
  it('fans out only to active followers of the exact issue/pr, unread, once per (user, event)', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    await createFollow(db, { userId: 'u2', targetType: 'issue', targetRef: '92' })
    await createFollow(db, { userId: 'u3', targetType: 'issue', targetRef: '93' })
    await createFollow(db, { userId: 'u4', targetType: 'pr', targetRef: '92' }) // same number, other kind
    await db.prepare(`UPDATE follows SET archived = 1 WHERE user_id = ?`).bind('u2').run()

    const eventId = await recordActivityEvent(db, { entityId: 'ent-92', prNumber: null, dedupeKey: 'activity:issue:92:5000', payload: PAYLOAD })
    expect(await fanOutActivity(db, { eventId, entityKind: 'issue', number: 92 })).toBe(1)
    expect(await fanOutActivity(db, { eventId, entityKind: 'issue', number: 92 })).toBe(0) // idempotent

    const feed = await db.prepare(`SELECT user_id, matched_type, matched_ref, read_at FROM feed`).all<{
      user_id: string; matched_type: string; matched_ref: string; read_at: number | null
    }>()
    expect(feed.results).toEqual([{ user_id: 'u1', matched_type: 'issue', matched_ref: '92', read_at: null }])
  })
})
