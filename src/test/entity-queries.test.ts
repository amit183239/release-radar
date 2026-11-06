import { describe, it, expect, vi } from 'vitest'
import { makeTestDb } from './helpers/d1'
import {
  upsertEntity,
  getCachedPrs,
  getIssuesByNumbers,
  getEntitiesPrior,
} from '../lib/queries'
import { runPollWithSource } from '../jobs/poll'
import { FixturePollSource } from './fixtures/fixture-source'
import type { AppConfig } from '../config'

const REPO = 'o/r'

const issue = (n: number, over: Partial<Parameters<typeof upsertEntity>[1]> = {}) => ({
  repo: REPO, kind: 'issue' as const, number: n, title: `Issue ${n}`, state: 'OPEN', author: null,
  labels: [] as string[], closes: [] as number[], updatedAt: 100, url: `https://github.com/o/r/issues/${n}`, ...over,
})
const pr = (n: number, over: Partial<Parameters<typeof upsertEntity>[1]> = {}) => ({
  repo: REPO, kind: 'pr' as const, number: n, title: `PR ${n}`, state: 'MERGED', author: 'dev',
  labels: [] as string[], closes: [] as number[], updatedAt: 100, url: `https://github.com/o/r/pull/${n}`, ...over,
})

async function entityRow(db: D1Database, kind: string, n: number) {
  return db
    .prepare('SELECT milestone, issue_type, comments_count, last_meaningful_activity_at FROM entities WHERE repo = ? AND kind = ? AND number = ?')
    .bind(REPO, kind, n)
    .first<{ milestone: string | null; issue_type: string | null; comments_count: number | null; last_meaningful_activity_at: number | null }>()
}

describe('upsertEntity (v1 TODOs columns)', () => {
  it('clears milestone and issue_type when GitHub removes them', async () => {
    const db = makeTestDb()
    await upsertEntity(db, issue(92, { milestone: 'Q4', issueType: 'Bug' }))
    await upsertEntity(db, issue(92, { milestone: null, issueType: null, updatedAt: 200 }))
    expect(await entityRow(db, 'issue', 92)).toMatchObject({ milestone: null, issue_type: null })
  })

  it('keeps comments_count when a later upsert omits it', async () => {
    const db = makeTestDb()
    await upsertEntity(db, issue(92, { commentsCount: 4 }))
    await upsertEntity(db, issue(92, { updatedAt: 200 }))
    expect((await entityRow(db, 'issue', 92))!.comments_count).toBe(4)
    await upsertEntity(db, issue(92, { updatedAt: 300, commentsCount: 6 }))
    expect((await entityRow(db, 'issue', 92))!.comments_count).toBe(6)
  })

  it('sets last_meaningful_activity_at on insert and advances it only on activity', async () => {
    const db = makeTestDb()
    await upsertEntity(db, issue(92, { updatedAt: 100 }))
    expect((await entityRow(db, 'issue', 92))!.last_meaningful_activity_at).toBe(100)
    await upsertEntity(db, issue(92, { updatedAt: 200 })) // no activity
    expect((await entityRow(db, 'issue', 92))!.last_meaningful_activity_at).toBe(100)
    await upsertEntity(db, issue(92, { updatedAt: 300, lastMeaningfulActivityAt: 300 }))
    expect((await entityRow(db, 'issue', 92))!.last_meaningful_activity_at).toBe(300)
  })

  it('getCachedPrs returns number + milestone', async () => {
    const db = makeTestDb()
    await upsertEntity(db, pr(7, { milestone: 'Q4' }))
    expect((await getCachedPrs(db, REPO, [7])).get(7)).toMatchObject({ number: 7, milestone: 'Q4' })
  })
})

describe('batch entity readers', () => {
  it('getCachedPrs returns PRs only, keyed by number, chunked at 90 binds', async () => {
    const db = makeTestDb()
    for (let n = 1; n <= 95; n++) await upsertEntity(db, pr(n, { milestone: n === 3 ? 'Q4' : null }))
    await upsertEntity(db, issue(3))
    const spy = vi.spyOn(db, 'prepare')
    const map = await getCachedPrs(db, REPO, [...Array.from({ length: 95 }, (_, i) => i + 1), 3, 999])
    expect(spy).toHaveBeenCalledTimes(2) // 95 unique -> 90 + 5
    expect(map.size).toBe(95)
    expect(map.get(3)).toMatchObject({ number: 3, milestone: 'Q4', author: 'dev' })
    expect(map.has(999)).toBe(false)
  })

  it('getIssuesByNumbers returns issue labels, type, milestone', async () => {
    const db = makeTestDb()
    await upsertEntity(db, issue(5, { labels: ['customer-facing'], issueType: 'Bug', milestone: 'Q4' }))
    await upsertEntity(db, pr(5))
    const map = await getIssuesByNumbers(db, REPO, [5, 6])
    expect(map.size).toBe(1)
    expect(map.get(5)).toEqual({ number: 5, labels_json: '["customer-facing"]', issue_type: 'Bug', milestone: 'Q4' })
  })

  it('getEntitiesPrior returns id/state/comments_count for one kind', async () => {
    const db = makeTestDb()
    await upsertEntity(db, issue(92, { state: 'OPEN', commentsCount: 2 }))
    await upsertEntity(db, pr(92, { state: 'OPEN' }))
    const map = await getEntitiesPrior(db, REPO, 'issue', [92])
    const row = map.get(92)!
    expect(row).toMatchObject({ number: 92, state: 'OPEN', comments_count: 2 })
    expect(typeof row.id).toBe('string')
  })

  it('empty input -> empty map, no queries', async () => {
    const db = makeTestDb()
    const spy = vi.spyOn(db, 'prepare')
    expect((await getCachedPrs(db, REPO, [])).size).toBe(0)
    expect((await getIssuesByNumbers(db, REPO, [])).size).toBe(0)
    expect((await getEntitiesPrior(db, REPO, 'pr', [])).size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

const TEST_CONFIG: AppConfig = {
  owner: 'o',
  repo: 'r',
  ownerRepo: REPO,
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

describe('poll syncs store the new fields', () => {
  it('syncEntities stores PR milestone + comments; syncIssues stores issue type + comments', async () => {
    const db = makeTestDb()
    const source = new FixturePollSource({
      mappingJson: JSON.stringify({ projects: { 'checkout-api': 'apps/checkout/api' } }),
      tags: [],
      compares: {},
      pullRequests: [
        {
          number: 7, title: 'PR 7', state: 'MERGED', authorLogin: 'dev', labels: [], closesIssues: [5],
          updatedAt: 100, mergedAt: 90, url: 'https://github.com/o/r/pull/7', body: null, files: [],
          milestone: 'Q4', commentsCount: 2,
        },
      ],
      issuePages: [[
        { number: 5, title: 'Bug', state: 'OPEN', labels: [], milestone: 'Q4', url: 'https://github.com/o/r/issues/5', updatedAt: 100, issueType: 'Bug', commentsCount: 1 },
      ]],
    })
    await runPollWithSource(db, TEST_CONFIG, source)
    expect(await entityRow(db, 'pr', 7)).toMatchObject({ milestone: 'Q4', comments_count: 2 })
    expect(await entityRow(db, 'issue', 5)).toMatchObject({ milestone: 'Q4', issue_type: 'Bug', comments_count: 1 })
  })
})
