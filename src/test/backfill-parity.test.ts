// Task 10: backfill attribution parity with the poll (spec §0d).
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertApp, upsertEntity, listPendingSummaries } from '../lib/queries'
import { createFollow } from '../lib/follows'
import { runBackfillWithSource } from '../jobs/backfill'
import type { PollSource } from '../jobs/poll'
import type { AppConfig } from '../config'
import type { ResolvedTag, CompareResult } from '../lib/github'

const BASE = 'base-parity'
const HEAD = 'head-parity'

class ParitySource implements PollSource {
  async getContent(_path: string, _etag?: string | null) {
    return { notModified: false, etag: 'e1', text: '{}' }
  }
  async fetchTagsPage(_cursor: string | null) {
    const now = Math.floor(Date.now() / 1000)
    const items: ResolvedTag[] = [
      { name: 'checkout-v1-production', commitSha: BASE, createdAt: now - 7200, lightweight: false },
      { name: 'checkout-v2-production', commitSha: HEAD, createdAt: now - 3600, lightweight: false },
    ]
    return { items, hasNextPage: false, endCursor: null }
  }
  async compare(base: string, _head: string): Promise<CompareResult> {
    if (base !== BASE) throw new Error(`unexpected base ${base}`)
    return {
      status: 'ahead',
      files: [],
      commits: [
        { message: 'feat: customer thing (#300)\n\nbody', sha: 'c300', authorLogin: null },
        { message: 'chore: internal thing (#301)\n\nbody', sha: 'c301', authorLogin: null },
      ],
      truncated: false,
    }
  }
  async searchPullRequestsPage(_since: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
  async searchIssuesPage(_since: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
}

function config(customerFacingLabels: string[]): AppConfig {
  return {
    owner: 'o',
    repo: 'r',
    ownerRepo: 'o/r',
    mappingPath: '.github/mapping.json',
    allowedDomains: ['example.com'],
    sharedLibBucket: 'platform',
    backfillDays: 1,
    aiProvider: 'off',
    aiModel: '',
    aiMonthlyCapCents: 0,
    customerFacingLabels,
    customerFacingIssueTypes: [],
    tagPattern: '{app}-v*-production',
  }
}

type Db = ReturnType<typeof makeTestDb>

async function seed(db: Db): Promise<void> {
  await upsertApp(db, { slug: 'checkout', display_name: 'Checkout' })
  await upsertEntity(db, {
    repo: 'o/r', kind: 'pr', number: 300, title: 'feat: customer thing', state: 'MERGED',
    author: 'dev', labels: ['customer-facing'], closes: [], updatedAt: 1000, url: 'u300',
    releaseNote: 'Customers can now do the thing.',
  })
  await upsertEntity(db, {
    repo: 'o/r', kind: 'pr', number: 301, title: 'chore: internal thing', state: 'MERGED',
    author: 'dev', labels: [], closes: [], updatedAt: 1000, url: 'u301',
  })
  await createFollow(db, { userId: 'u1', targetType: 'app', targetRef: 'checkout' })
}

describe('backfill parity with the poll', () => {
  it('writes curated copy, classifies customer_facing, records events, creates no feed rows', async () => {
    const db = makeTestDb()
    await seed(db)
    await runBackfillWithSource(db, config(['customer-facing']), new ParitySource())

    const notes = await db
      .prepare('SELECT pr_number, note_technical, copy_source, customer_facing FROM notes ORDER BY pr_number')
      .bind()
      .all<{ pr_number: number; note_technical: string; copy_source: string; customer_facing: number }>()
    expect(notes.results).toEqual([
      { pr_number: 300, note_technical: 'Customers can now do the thing.', copy_source: 'human', customer_facing: 1 },
      { pr_number: 301, note_technical: 'chore: internal thing', copy_source: 'fallback', customer_facing: 0 },
    ])

    const events = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'shipped'")
      .bind()
      .first<{ n: number }>()
    expect(events?.n).toBe(2)

    const feed = await db.prepare('SELECT COUNT(*) AS n FROM feed').bind().first<{ n: number }>()
    expect(feed?.n).toBe(0)
  })

  it('persona guard: with no customer-facing config, backfill enqueues no cx summaries', async () => {
    const db = makeTestDb()
    await seed(db)
    await runBackfillWithSource(db, config([]), new ParitySource())
    const pending = await listPendingSummaries(db, 50)
    expect(pending.length).toBe(2) // developer summaries are always pending
    expect(pending.filter((p) => p.customer_facing === 1)).toEqual([])
  })
})
