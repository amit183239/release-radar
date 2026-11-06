import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { listFeed, recordActivityEvent, fanOutActivity, recordShipEvent, fanOutShip } from '../lib/events'
import { createFollow } from '../lib/follows'
import { upsertEntity, upsertRelease } from '../lib/queries'

const REPO = 'o/r'

async function rel(db: ReturnType<typeof makeTestDb>): Promise<string> {
  return upsertRelease(db, {
    app: 'checkout', ref: 'sha1', tag: 'checkout-v1-production',
    deployedAt: 1_000, baseRef: 'sha0', divergent: false,
  })
}

describe('listFeed — activity rows', () => {
  it('returns kind + parsed payload, and ONLY the stored match (no label/issue re-derivation)', async () => {
    const db = makeTestDb()
    // PR #140 has a label the user ALSO follows — an activity row must not claim it.
    await upsertEntity(db, {
      repo: REPO, kind: 'pr', number: 140, title: 'Retry webhooks', state: 'MERGED', author: 'dev',
      labels: ['bug'], closes: [92], updatedAt: 2_000, url: 'https://github.com/o/r/pull/140',
    })
    await createFollow(db, { userId: 'u1', targetType: 'pr', targetRef: '140', customerRef: 'ACME-123', ticketRef: 'ZD-1' })
    await createFollow(db, { userId: 'u1', targetType: 'label', targetRef: 'bug' })
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })

    const eventId = await recordActivityEvent(db, {
      entityId: 'ent-140',
      prNumber: 140,
      dedupeKey: 'activity:pr:140:2000',
      payload: { entity_kind: 'pr', number: 140, title: 'Retry webhooks', url: 'https://github.com/o/r/pull/140', state_from: 'OPEN', state_to: 'MERGED' },
    })
    await fanOutActivity(db, { eventId, entityKind: 'pr', number: 140 })

    const items = await listFeed(db, 'u1', REPO)
    expect(items).toHaveLength(1)
    const it0 = items[0]!
    expect(it0.kind).toBe('activity')
    expect(it0.payload).toEqual({
      entity_kind: 'pr', number: 140, title: 'Retry webhooks', url: 'https://github.com/o/r/pull/140',
      state_from: 'OPEN', state_to: 'MERGED',
    })
    expect(it0.matches).toEqual([{ type: 'pr', ref: '140', customer_ref: 'ACME-123', ticket_ref: 'ZD-1' }])
    expect(it0.matched_type).toBe('pr')
    expect(it0.matched_ref).toBe('140')
  })

  it('issue activity (pr_number NULL) still renders from payload', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    const eventId = await recordActivityEvent(db, {
      entityId: 'ent-92',
      prNumber: null,
      dedupeKey: 'activity:issue:92:3000',
      payload: { entity_kind: 'issue', number: 92, title: 'Checkout fails', url: null, new_comments: 3 },
    })
    await fanOutActivity(db, { eventId, entityKind: 'issue', number: 92 })
    const [item] = await listFeed(db, 'u1', REPO)
    expect(item!.kind).toBe('activity')
    expect(item!.pr_number).toBeNull()
    expect(item!.payload).toEqual({ entity_kind: 'issue', number: 92, title: 'Checkout fails', url: null, new_comments: 3 })
    expect(item!.matches).toEqual([{ type: 'issue', ref: '92', customer_ref: null, ticket_ref: null }])
  })
})

describe('listFeed — ship rows carry follow refs', () => {
  it('attaches customer_ref/ticket_ref from the matching follow; payload is null', async () => {
    const db = makeTestDb()
    await upsertEntity(db, {
      repo: REPO, kind: 'pr', number: 150, title: 'Fix ACME checkout', state: 'MERGED', author: 'dev',
      labels: [], closes: [92], updatedAt: 2_000, url: 'https://github.com/o/r/pull/150',
    })
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92', customerRef: 'ACME-123', ticketRef: 'https://acme.zendesk.com/t/1' })
    const eventId = await recordShipEvent(db, { app: 'checkout', releaseId: await rel(db), prNumber: 150 })
    await fanOutShip(db, {
      eventId,
      app: 'checkout',
      prNumber: 150,
      closesIssues: [92],
      prLabels: [],
      milestones: [],
      noteTechnical: 'Fix ACME checkout',
      queryFollows: [],
    })
    const [item] = await listFeed(db, 'u1', REPO)
    expect(item!.kind).toBe('shipped')
    expect(item!.payload).toBeNull()
    expect(item!.matches[0]).toEqual({ type: 'issue', ref: '92', customer_ref: 'ACME-123', ticket_ref: 'https://acme.zendesk.com/t/1' })
  })

  it('never exposes another user\'s refs', async () => {
    const db = makeTestDb()
    await upsertEntity(db, {
      repo: REPO, kind: 'pr', number: 150, title: 'Fix', state: 'MERGED', author: 'dev',
      labels: [], closes: [92], updatedAt: 2_000, url: null,
    })
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    await createFollow(db, { userId: 'u2', targetType: 'issue', targetRef: '92', customerRef: 'SECRET-CO' })
    const eventId = await recordShipEvent(db, { app: 'checkout', releaseId: await rel(db), prNumber: 150 })
    await fanOutShip(db, {
      eventId, app: 'checkout', prNumber: 150, closesIssues: [92], prLabels: [],
      milestones: [], noteTechnical: 'Fix', queryFollows: [],
    })
    const [item] = await listFeed(db, 'u1', REPO)
    expect(item!.matches[0]).toEqual({ type: 'issue', ref: '92', customer_ref: null, ticket_ref: null })
  })
})

describe('createFollow — ref COALESCE on re-follow', () => {
  it('keeps existing refs when re-followed without refs; replaces when new refs are given', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92', customerRef: 'ACME-123', ticketRef: 'ZD-1' })
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    let row = await db.prepare(`SELECT customer_ref, ticket_ref FROM follows WHERE user_id = ?`).bind('u1').first<{ customer_ref: string; ticket_ref: string }>()
    expect(row).toEqual({ customer_ref: 'ACME-123', ticket_ref: 'ZD-1' })

    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92', customerRef: 'ACME-999', ticketRef: null })
    row = await db.prepare(`SELECT customer_ref, ticket_ref FROM follows WHERE user_id = ?`).bind('u1').first<{ customer_ref: string; ticket_ref: string }>()
    expect(row).toEqual({ customer_ref: 'ACME-999', ticket_ref: 'ZD-1' })
  })
})
