/**
 * End-to-end poll against a real D1 (workerd/Miniflare), migrations applied from
 * scratch. Three runs, each with a FRESH FixturePollSource (its issue cursor is
 * stateful; it ignores updatedSinceISO — cursor logic is unit-tested in Task 6):
 *   1. seed follows (milestone, query, app, issue) → poll → releases/notes/events
 *      + one feed row per follower with the expected matched_type
 *   2. identical data → row counts unchanged (idempotency)
 *   3. issue #92 CLOSED + commentsCount 1→3 → exactly one activity event and one
 *      new feed row (for the issue follower only)
 */
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { runPollWithSource } from '../../src/jobs/poll'
import { createFollow } from '../../src/lib/follows'
import { FixturePollSource, type FixtureData } from '../../src/test/fixtures/fixture-source'
import type { AppConfig } from '../../src/config'
import type { IssueNode, PullRequestNode } from '../../src/lib/github'

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

const MAPPING_JSON = JSON.stringify({
  projects: { 'checkout-api': 'apps/checkout/api', 'platform-api': 'apps/platform/api' },
})
const BASE = 'sha-checkout-v100'
const HEAD = 'sha-checkout-v110'

const PR_301: PullRequestNode = {
  number: 301,
  title: 'feat: shared promo engine',
  state: 'MERGED',
  authorLogin: 'dev1',
  labels: ['enhancement'],
  closesIssues: [92],
  updatedAt: 1_700_000_100,
  mergedAt: 1_700_000_100,
  url: 'https://github.com/o/r/pull/301',
  body: null,
  files: ['apps/checkout/api/promo.ts'],
  milestone: 'Q4 Checkout',
  commentsCount: 0,
}

function issue92(state: string, commentsCount: number, updatedAt: number): IssueNode {
  return {
    number: 92,
    title: 'Checkout fails for ACME',
    state,
    labels: ['bug'],
    milestone: 'Q4 Checkout',
    url: 'https://github.com/o/r/issues/92',
    updatedAt,
    commentsCount,
    issueType: null,
  }
}

function fixture(issue: IssueNode): FixtureData {
  return {
    mappingJson: MAPPING_JSON,
    tags: [
      { name: 'checkout-v1.0.0-production', commitSha: BASE, createdAt: 1000, lightweight: false },
      { name: 'checkout-v1.1.0-production', commitSha: HEAD, createdAt: 2000, lightweight: false },
    ],
    compares: {
      [`${BASE}...${HEAD}`]: {
        status: 'ahead',
        files: [],
        commits: [{ message: 'feat: shared promo engine (#301)\n\nbody', sha: 'c301', authorLogin: 'dev1' }],
        truncated: false,
      },
    },
    pullRequests: [PR_301],
    issuePages: [[issue]],
  }
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>()
  return row?.n ?? 0
}

async function feedFor(userId: string): Promise<Array<{ matched_type: string; kind: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT f.matched_type, e.kind FROM feed f JOIN events e ON e.id = f.event_id
      WHERE f.user_id = ? ORDER BY e.kind, f.matched_type`
  ).bind(userId).all<{ matched_type: string; kind: string }>()
  return results ?? []
}

async function snapshot() {
  return {
    releases: await count('SELECT COUNT(*) AS n FROM releases'),
    notes: await count('SELECT COUNT(*) AS n FROM notes'),
    shipped: await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'shipped'`),
    activity: await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'activity'`),
    feed: await count('SELECT COUNT(*) AS n FROM feed'),
  }
}

describe('poll end-to-end on real D1', () => {
  it('fans out milestone/query/app/issue, is idempotent, and re-surfaces activity', async () => {
    const db = env.DB
    await createFollow(db, { userId: 'u-milestone', targetType: 'milestone', targetRef: 'Q4 Checkout' })
    await createFollow(db, { userId: 'u-query', targetType: 'query', targetRef: 'promo engine' })
    await createFollow(db, { userId: 'u-app', targetType: 'app', targetRef: 'checkout' })
    await createFollow(db, { userId: 'u-issue', targetType: 'issue', targetRef: '92' })

    // Run 1 — first sighting of #92 (no activity), one ship of PR #301.
    await runPollWithSource(db, CONFIG, new FixturePollSource(fixture(issue92('OPEN', 1, 1_700_000_000))))
    const s1 = await snapshot()
    expect(s1).toEqual({ releases: 1, notes: 1, shipped: 1, activity: 0, feed: 4 })
    expect(await feedFor('u-milestone')).toEqual([{ matched_type: 'milestone', kind: 'shipped' }])
    expect(await feedFor('u-query')).toEqual([{ matched_type: 'query', kind: 'shipped' }])
    expect(await feedFor('u-app')).toEqual([{ matched_type: 'app', kind: 'shipped' }])
    expect(await feedFor('u-issue')).toEqual([{ matched_type: 'issue', kind: 'shipped' }])

    // Run 2 — identical data: nothing new.
    await runPollWithSource(db, CONFIG, new FixturePollSource(fixture(issue92('OPEN', 1, 1_700_000_000))))
    expect(await snapshot()).toEqual(s1)

    // Run 3 — #92 closed + 2 new comments, later updatedAt.
    await runPollWithSource(db, CONFIG, new FixturePollSource(fixture(issue92('CLOSED', 3, 1_700_000_500))))
    expect(await snapshot()).toEqual({ ...s1, activity: 1, feed: 5 })
    expect(await feedFor('u-issue')).toEqual([
      { matched_type: 'issue', kind: 'activity' },
      { matched_type: 'issue', kind: 'shipped' },
    ])
    expect(await feedFor('u-milestone')).toHaveLength(1)
    const payload = await db
      .prepare(`SELECT payload_json FROM events WHERE kind = 'activity'`)
      .first<{ payload_json: string }>()
    expect(JSON.parse(payload!.payload_json)).toMatchObject({
      entity_kind: 'issue', number: 92, state_from: 'OPEN', state_to: 'CLOSED', new_comments: 2,
    })
  })
})
