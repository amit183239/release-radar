import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { setSyncState, getSyncState } from '../lib/queries'
import { runPollWithSource } from '../jobs/poll'
import { FixturePollSource } from './fixtures/fixture-source'
import { QueryBudget } from '../lib/budget'
import { epochToCursor } from '../lib/sync-cursor'
import type { AppConfig } from '../config'
import type { PullRequestNode, IssueNode } from '../lib/github'

const REPO = 'o/r'
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const MAPPING = JSON.stringify({ projects: { 'checkout-api': 'apps/checkout/api' } })

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

const prNode = (number: number, updatedAt: number): PullRequestNode => ({
  number, title: `PR ${number}`, state: 'MERGED', authorLogin: 'dev', labels: [], closesIssues: [],
  updatedAt, mergedAt: updatedAt, url: `https://github.com/o/r/pull/${number}`, body: null, files: [],
})
const issueNode = (number: number, updatedAt: number): IssueNode => ({
  number, title: `Issue ${number}`, state: 'OPEN', labels: [], milestone: null,
  url: `https://github.com/o/r/issues/${number}`, updatedAt,
})

async function seedCursor(db: D1Database, key: string, cursor: string, lastSyncedAt: number) {
  await setSyncState(db, key, cursor, 'ok')
  await db.prepare('UPDATE sync_state SET last_synced_at = ? WHERE key = ?').bind(lastSyncedAt, key).run()
}

describe('sync cursor wiring', () => {
  it('normalizes a legacy date cursor for the query and advances to maxSeen - overlap', async () => {
    const db = makeTestDb()
    await seedCursor(db, 'pr-search', '2026-11-01', 0)
    const src = new FixturePollSource({
      mappingJson: MAPPING, tags: [], compares: {},
      pullRequests: [prNode(7, T('2026-11-01T12:00:00Z'))],
    })
    await runPollWithSource(db, TEST_CONFIG, src)
    expect(src.prSinceCalls[0]).toBe('2026-11-01T00:00:00Z')
    expect((await getSyncState(db, 'pr-search'))!.cursor).toBe('2026-11-01T11:00:00Z')
  })

  it('zero results leave the cursor unchanged even if last_synced_at is far ahead', async () => {
    const db = makeTestDb()
    await seedCursor(db, 'pr-search', '2026-11-02T10:00:00Z', 1_900_000_000)
    await seedCursor(db, 'issue-search', '2026-11-02T10:00:00Z', 1_900_000_000)
    const src = new FixturePollSource({ mappingJson: MAPPING, tags: [], compares: {}, pullRequests: [], issuePages: [] })
    await runPollWithSource(db, TEST_CONFIG, src)
    expect((await getSyncState(db, 'pr-search'))!.cursor).toBe('2026-11-02T10:00:00Z')
    expect((await getSyncState(db, 'issue-search'))!.cursor).toBe('2026-11-02T10:00:00Z')
  })

  it('issue path uses the same timestamp cursor + one overlap constant (same-day changes are seen)', async () => {
    const db = makeTestDb()
    await seedCursor(db, 'issue-search', '2026-11-01T05:00:00Z', 0)
    const src = new FixturePollSource({
      mappingJson: MAPPING, tags: [], compares: {},
      issuePages: [[issueNode(92, T('2026-11-01T09:30:00Z'))]],
    })
    await runPollWithSource(db, TEST_CONFIG, src)
    expect(src.issueSinceCalls[0]).toBe('2026-11-01T05:00:00Z')
    expect((await getSyncState(db, 'issue-search'))!.cursor).toBe('2026-11-01T08:30:00Z')
  })

  it('first run uses a 30-day timestamp window', async () => {
    const db = makeTestDb()
    const src = new FixturePollSource({ mappingJson: MAPPING, tags: [], compares: {} })
    await runPollWithSource(db, TEST_CONFIG, src)
    expect(src.prSinceCalls[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const since = Math.floor(Date.parse(src.prSinceCalls[0]!) / 1000)
    const expected = Math.floor(Date.now() / 1000) - 30 * 86_400
    expect(Math.abs(since - expected)).toBeLessThan(120)
  })

  it('a capped PR sweep advances to max(prior+1, maxSeen-60) instead of freezing', async () => {
    const db = makeTestDb()
    const BASE = T('2026-11-03T10:00:00Z')
    await seedCursor(db, 'pr-search', epochToCursor(BASE - 100), 0)
    // Every page reports hasNextPage=true -> the 5-page cap is hit.
    class CappedSource extends FixturePollSource {
      override async searchPullRequestsPage(since: string, cursor: string | null) {
        this.prSinceCalls.push(since)
        const n = cursor ? Number(cursor) : 0
        return { items: [prNode(1000 + n, BASE + n * 10)], hasNextPage: true, endCursor: String(n + 1) }
      }
    }
    const src = new CappedSource({ mappingJson: MAPPING, tags: [], compares: {} })
    await runPollWithSource(db, TEST_CONFIG, src)
    // pages n=0..4 -> maxSeen = BASE + 40 -> max(BASE-99, BASE-20) = BASE-20
    expect((await getSyncState(db, 'pr-search'))!.cursor).toBe(epochToCursor(BASE - 20))
  })

  describe('budget early-stop mid-sweep', () => {
    const BASE = T('2026-11-03T10:00:00Z')
    class MoreSource extends FixturePollSource {
      override async searchPullRequestsPage(_since: string, cursor: string | null) {
        const n = cursor ? Number(cursor) : 0
        return { items: [prNode(2000 + n, BASE + n * 10)], hasNextPage: true, endCursor: String(n + 1) }
      }
    }

    it('budget exhausted after page 0 still advances the cursor (capped rule), not frozen', async () => {
      const db = makeTestDb()
      const prior = epochToCursor(BASE - 100)
      await seedCursor(db, 'pr-search', prior, 0)
      const src = new MoreSource({ mappingJson: MAPPING, tags: [], compares: {} })
      // Page 0 upserts 1 PR -> spend(1) -> exhausted before page 1 is fetched.
      await runPollWithSource(db, TEST_CONFIG, src, new QueryBudget(1))
      const cursor = (await getSyncState(db, 'pr-search'))!.cursor!
      expect(Date.parse(cursor)).toBeGreaterThan(Date.parse(prior))
      // maxSeen = BASE (page 0 only) -> max(prior+1, BASE-60) = BASE-60
      expect(cursor).toBe(epochToCursor(BASE - 60))
    })

    it('budget exhausted before page 0 leaves the cursor unchanged', async () => {
      const db = makeTestDb()
      const prior = epochToCursor(BASE - 100)
      await seedCursor(db, 'pr-search', prior, 0)
      const src = new MoreSource({ mappingJson: MAPPING, tags: [], compares: {} })
      await runPollWithSource(db, TEST_CONFIG, src, new QueryBudget(0))
      expect((await getSyncState(db, 'pr-search'))!.cursor).toBe(prior)
    })
  })
})
