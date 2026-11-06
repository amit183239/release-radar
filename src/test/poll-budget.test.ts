// Task 8: per-tick D1 query budget + per-pair last_ref advance (spec §0e).
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertApp, advanceLastRef, getApp } from '../lib/queries'
import { runPollWithSource, type PollSource } from '../jobs/poll'
import { QueryBudget, DEFAULT_QUERY_BUDGET } from '../lib/budget'
import type { AppConfig } from '../config'
import type { ResolvedTag, CompareResult } from '../lib/github'

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

/** checkout tags v1 (sha1@1000), v2 (sha2@2000), v3 (sha3@3000); empty compares. */
class ChainSource implements PollSource {
  constructor(private readonly failBase: string | null = null) {}
  async getContent(_path: string, _etag?: string | null) {
    return {
      notModified: false,
      etag: 'e1',
      text: JSON.stringify({ projects: { 'checkout-api': 'apps/checkout/api' } }),
    }
  }
  async fetchTagsPage(_cursor: string | null) {
    const items: ResolvedTag[] = [
      { name: 'checkout-v1-production', commitSha: 'sha1', createdAt: 1000, lightweight: false },
      { name: 'checkout-v2-production', commitSha: 'sha2', createdAt: 2000, lightweight: false },
      { name: 'checkout-v3-production', commitSha: 'sha3', createdAt: 3000, lightweight: false },
    ]
    return { items, hasNextPage: false, endCursor: null }
  }
  async compare(base: string, _head: string): Promise<CompareResult> {
    if (base === this.failBase) throw new Error('boom')
    return { status: 'ahead', files: [], commits: [], truncated: false }
  }
  async searchPullRequestsPage(_since: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
  async searchIssuesPage(_since: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
}

type Db = ReturnType<typeof makeTestDb>

async function seedTracked(db: Db): Promise<void> {
  await upsertApp(db, { slug: 'checkout', display_name: 'checkout' })
  await advanceLastRef(db, 'checkout', 'sha1', 1000)
}

async function lastRef(db: Db): Promise<string | null | undefined> {
  return (await getApp(db, 'checkout'))?.last_ref
}

describe('QueryBudget', () => {
  it('defaults to 800 and counts down', () => {
    const b = new QueryBudget()
    expect(DEFAULT_QUERY_BUDGET).toBe(800)
    expect(b.remaining).toBe(800)
    b.spend()
    b.spend(9)
    expect(b.remaining).toBe(790)
    expect(b.exhausted).toBe(false)
  })

  it('is exhausted at the limit and remaining never goes negative', () => {
    const b = new QueryBudget(5)
    b.spend(7)
    expect(b.exhausted).toBe(true)
    expect(b.remaining).toBe(0)
  })
})

describe('processTags — per-pair last_ref + budget', () => {
  it('advances last_ref per pair: a failure on pair 2 keeps pair 1 committed', async () => {
    const db = makeTestDb()
    await seedTracked(db)
    // Pairs after sinceAt=1000: v2 (base sha1), v3 (base sha2). v3's compare throws.
    await expect(runPollWithSource(db, CONFIG, new ChainSource('sha2'))).rejects.toThrow('boom')
    expect(await lastRef(db)).toBe('sha2')
  })

  it('stops cleanly between pairs when the budget is spent, then resumes next tick', async () => {
    const db = makeTestDb()
    await seedTracked(db)
    const r1 = await runPollWithSource(db, CONFIG, new ChainSource(), new QueryBudget(1))
    expect(r1.budgetExhausted).toBe(true)
    expect(await lastRef(db)).toBe('sha2') // first pair always runs, then stop
    const r2 = await runPollWithSource(db, CONFIG, new ChainSource())
    expect(r2.budgetExhausted ?? false).toBe(false)
    expect(await lastRef(db)).toBe('sha3')
  })
})

describe('processTags — fan-out cost is charged to the budget', () => {
  /** v2 pair has exactly one PR (#5); v3 pair is empty. Only v2 is polled. */
  class OnePrSource extends ChainSource {
    override async compare(base: string, _head: string): Promise<CompareResult> {
      const commits =
        base === 'sha1'
          ? [{ sha: 'c5', message: 'feat: thing (#5)', authorLogin: 'dev', date: 1500 }]
          : []
      return { status: 'ahead', files: [], commits: commits as never, truncated: false }
    }
  }

  async function spentWithFollowers(n: number): Promise<{ spent: number; feed: number }> {
    const db = makeTestDb()
    await seedTracked(db)
    for (let i = 0; i < n; i++) {
      await db
        .prepare(
          `INSERT INTO follows (id, user_id, target_type, target_ref, archived, created_at)
           VALUES (?, ?, 'app', 'checkout', 0, 1)`
        )
        .bind(`f${i}`, `user${i}`)
        .run()
    }
    const LIMIT = 10_000
    const budget = new QueryBudget(LIMIT)
    const r = await runPollWithSource(db, CONFIG, new OnePrSource(), budget)
    return { spent: LIMIT - budget.remaining, feed: r.feedItemsCreated ?? 0 }
  }

  it('charges at least N more queries when one PR fans out to N followers', async () => {
    const N = 8
    const base = await spentWithFollowers(0)
    const fan = await spentWithFollowers(N)
    expect(base.feed).toBe(0)
    expect(fan.feed).toBe(N)
    expect(fan.spent - base.spent).toBeGreaterThanOrEqual(N)
  })
})
