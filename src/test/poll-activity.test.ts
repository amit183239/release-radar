import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { runPollWithSource } from '../jobs/poll'
import { resolveConfig } from '../config'
import { createFollow } from '../lib/follows'
import { FixturePollSource } from './fixtures/fixture-source'
import type { IssueNode, PullRequestNode } from '../lib/github'

const CONFIG = resolveConfig({
  GITHUB_REPO: 'o/r',
  RELEASE_TAG_PATTERN: '{app}-*-production',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  BACKFILL_DAYS: '90',
  MAPPING_JSON_PATH: '.github/mapping.json',
  SHARED_LIB_BUCKET: 'platform',
  CUSTOMER_FACING_LABELS: '',
  AI_PROVIDER: 'off',
} as any)

const MAPPING = JSON.stringify({ projects: { 'checkout-api': 'apps/checkout/api' } })

function issue(over: Partial<IssueNode>): IssueNode {
  return {
    number: 92,
    title: 'Checkout fails for ACME',
    state: 'OPEN',
    labels: [],
    milestone: null,
    url: 'https://github.com/o/r/issues/92',
    updatedAt: 1_000,
    commentsCount: 1,
    issueType: null,
    ...over,
  }
}

function pr(over: Partial<PullRequestNode>): PullRequestNode {
  return {
    number: 140,
    title: 'Retry webhooks',
    state: 'OPEN',
    authorLogin: 'dev',
    labels: [],
    closesIssues: [],
    updatedAt: 1_000,
    mergedAt: null,
    url: 'https://github.com/o/r/pull/140',
    body: null,
    files: [],
    commentsCount: 0,
    milestone: null,
    ...over,
  }
}

function source(issues: IssueNode[], prs: PullRequestNode[]) {
  return new FixturePollSource({ mappingJson: MAPPING, tags: [], compares: {}, pullRequests: prs, issuePages: [issues] })
}

async function count(db: ReturnType<typeof makeTestDb>, sql: string): Promise<number> {
  const r = await db.prepare(sql).first<{ c: number }>()
  return r?.c ?? 0
}

describe('poll re-surface activity', () => {
  it('first sighting emits nothing; a state change + comments emits one event and one feed row', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    await createFollow(db, { userId: 'u2', targetType: 'pr', targetRef: '140' })

    // Run 1: first sighting -> baseline only.
    const r1 = await runPollWithSource(db, CONFIG, source([issue({})], [pr({})]))
    expect(r1.activityItemsCreated).toBe(0)
    expect(await count(db, `SELECT COUNT(*) AS c FROM events WHERE kind = 'activity'`)).toBe(0)

    // Run 2: issue closed + 2 comments; PR merged.
    const r2 = await runPollWithSource(
      db,
      CONFIG,
      source([issue({ state: 'CLOSED', commentsCount: 3, updatedAt: 2_000 })], [pr({ state: 'MERGED', updatedAt: 2_000 })])
    )
    expect(r2.activityItemsCreated).toBe(2)

    const ev = await db
      .prepare(`SELECT payload_json FROM events WHERE kind = 'activity' AND dedupe_key = ?`)
      .bind('activity:issue:92:2000')
      .first<{ payload_json: string }>()
    expect(JSON.parse(ev!.payload_json)).toEqual({
      entity_kind: 'issue',
      number: 92,
      title: 'Checkout fails for ACME',
      url: 'https://github.com/o/r/issues/92',
      state_from: 'OPEN',
      state_to: 'CLOSED',
      new_comments: 2,
    })
    expect(await count(db, `SELECT COUNT(*) AS c FROM feed WHERE user_id = 'u1' AND read_at IS NULL`)).toBe(1)
    expect(await count(db, `SELECT COUNT(*) AS c FROM feed WHERE user_id = 'u2' AND read_at IS NULL`)).toBe(1)

    // last_meaningful_activity_at advanced; comments_count stored.
    const ent = await db
      .prepare(`SELECT last_meaningful_activity_at AS lma, comments_count FROM entities WHERE kind = 'issue' AND number = 92`)
      .first<{ lma: number; comments_count: number }>()
    expect(ent).toEqual({ lma: 2_000, comments_count: 3 })

    // Run 3: same data again -> no new events or feed rows (idempotent).
    const r3 = await runPollWithSource(
      db,
      CONFIG,
      source([issue({ state: 'CLOSED', commentsCount: 3, updatedAt: 2_000 })], [pr({ state: 'MERGED', updatedAt: 2_000 })])
    )
    expect(r3.activityItemsCreated).toBe(0)
    expect(await count(db, `SELECT COUNT(*) AS c FROM events WHERE kind = 'activity'`)).toBe(2)
    expect(await count(db, `SELECT COUNT(*) AS c FROM feed`)).toBe(2)
  })

  it('a label-only edit is not activity and does not advance last_meaningful_activity_at', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    await runPollWithSource(db, CONFIG, source([issue({})], []))
    await runPollWithSource(db, CONFIG, source([issue({ labels: ['bug'], updatedAt: 3_000 })], []))
    expect(await count(db, `SELECT COUNT(*) AS c FROM events WHERE kind = 'activity'`)).toBe(0)
    const ent = await db
      .prepare(`SELECT last_meaningful_activity_at AS lma FROM entities WHERE kind = 'issue' AND number = 92`)
      .first<{ lma: number }>()
    expect(ent?.lma).toBe(1_000)
  })

  it('a pre-0008 row (NULL comments_count) does not flood on its first tick after deploy', async () => {
    const db = makeTestDb()
    await createFollow(db, { userId: 'u1', targetType: 'issue', targetRef: '92' })
    await runPollWithSource(db, CONFIG, source([issue({})], []))
    await db.prepare(`UPDATE entities SET comments_count = NULL WHERE kind = 'issue' AND number = 92`).run()
    const r = await runPollWithSource(db, CONFIG, source([issue({ commentsCount: 50, updatedAt: 4_000 })], []))
    expect(r.activityItemsCreated).toBe(0)
    const ent = await db
      .prepare(`SELECT comments_count FROM entities WHERE kind = 'issue' AND number = 92`)
      .first<{ comments_count: number }>()
    expect(ent?.comments_count).toBe(50) // rebaselined
  })
})
