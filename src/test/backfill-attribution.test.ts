/**
 * TDD test for Task 5: per-PR path-scoping gate in backfill.
 *
 * Mirrors Task 4 (poll-attribution.test.ts) but drives runBackfillWithSource
 * instead of runPollWithSource.
 *
 * Fixture setup:
 *   - 3 apps: attribution, platform, checkout (seeded via upsertApp)
 *   - shared lib bucket: "platform"
 *   - PR #171 files: apps/attribution/** -> scopes to "attribution" only
 *   - PR #172 files: apps/platform/**    -> scopes to "platform" only
 *   - PR #200 files: none (null)        -> unknown, kept everywhere
 *
 * Tag fixture: only checkout tags (base + head), so the compare returns all
 * three PRs. After backfill, checkout should only get [200] (171 scopes to
 * attribution, 172 to platform — neither scope to checkout; 200 unknown -> kept).
 *
 * Expected notes after runBackfillWithSource:
 *   checkout -> [200]
 */
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity, upsertApp } from '../lib/queries'
import { runBackfillWithSource } from '../jobs/backfill'
import type { AppConfig } from '../config'
import type { ResolvedTag, CompareResult } from '../lib/github'
import type { PollSource } from '../jobs/poll'

// ---------------------------------------------------------------------------
// Tag pattern: "{app}-v{version}-production"
// ---------------------------------------------------------------------------
const TAG_PATTERN = '{app}-v*-production'

// ---------------------------------------------------------------------------
// Shared SHAs
// ---------------------------------------------------------------------------
const BASE_SHA_CHK = 'base-checkout-sha-bf'
const HEAD_SHA = 'head-sha-v210-bf'

// ---------------------------------------------------------------------------
// Commits in the compare range: PRs #171, #172, #200
// ---------------------------------------------------------------------------
const COMMITS_171_172_200 = [
  { message: 'feat: attribution tracking fix (#171)\n\nbody', sha: 'c171', authorLogin: null },
  { message: 'fix: platform consent banner flicker (#172)\n\nbody', sha: 'c172', authorLogin: null },
  { message: 'chore: untracked infra change (#200)\n\nbody', sha: 'c200', authorLogin: null },
]

// ---------------------------------------------------------------------------
// A minimal PollSource stub for this test.
// Provides: fetchTagsPage (checkout tags only), compare (shared result).
// Does NOT provide entities (we seed those directly via upsertEntity).
// getContent is never called by backfill (no mapping sync), but the
// PollSource interface requires it so we provide a stub.
// ---------------------------------------------------------------------------
class BackfillAttributionTestSource implements PollSource {
  async getContent(_path: string, _etag?: string | null) {
    return { notModified: false, etag: 'etag-1', text: '{}' }
  }

  async fetchTagsPage(_cursor: string | null): Promise<{
    items: ResolvedTag[]
    hasNextPage: boolean
    endCursor: string | null
  }> {
    // Two checkout tags: base (older) + head (newer), both within backfillDays window.
    // createdAt uses epoch seconds relative to "now" to stay in-window.
    // We use fixed past timestamps; the window is config.backfillDays * 86400 = 7 * 86400 = 604800s.
    // Use timestamps close to now so they fall in-window for any reasonable test run.
    const nowSec = Math.floor(Date.now() / 1000)
    const tags: ResolvedTag[] = [
      {
        name: 'checkout-v2.0.0-production',
        commitSha: BASE_SHA_CHK,
        createdAt: nowSec - 3600 * 2, // 2h ago (in-window)
        lightweight: false,
      },
      {
        name: 'checkout-v2.1.0-production',
        commitSha: HEAD_SHA,
        createdAt: nowSec - 3600 * 1, // 1h ago (in-window)
        lightweight: false,
      },
    ]
    return { items: tags, hasNextPage: false, endCursor: null }
  }

  async compare(base: string, _head: string): Promise<CompareResult> {
    if (base === BASE_SHA_CHK) {
      return {
        status: 'ahead',
        files: [],
        commits: COMMITS_171_172_200,
        truncated: false,
      }
    }
    throw new Error(`fixture: unexpected compare base: ${base}`)
  }

  async searchPullRequestsPage(
    _updatedSinceISO: string,
    _cursor: string | null
  ) {
    return { items: [], hasNextPage: false, endCursor: null }
  }

  async searchIssuesPage(_updatedSinceISO: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
}

// ---------------------------------------------------------------------------
// Test config — mirrors poll-attribution test, backfillDays=1 (well within our
// 1h-old timestamps).
// ---------------------------------------------------------------------------
const TEST_CONFIG: AppConfig = {
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
  customerFacingLabels: [],
  customerFacingIssueTypes: [],
  tagPattern: TAG_PATTERN,
}

// ---------------------------------------------------------------------------
// Helper: list PR numbers attributed to an app (by app slug on releases).
// ---------------------------------------------------------------------------
async function notesFor(db: ReturnType<typeof makeTestDb>, app: string): Promise<number[]> {
  const r = await db
    .prepare(
      'SELECT n.pr_number FROM notes n JOIN releases r ON r.id=n.release_id WHERE r.app=? ORDER BY n.pr_number'
    )
    .bind(app)
    .all<{ pr_number: number }>()
  return r.results.map((x) => x.pr_number)
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------
describe('backfill path-scoped attribution', () => {
  it('attributes each PR only to the app its files scope to; unknown files kept', async () => {
    const db = makeTestDb()

    // Seed the app registry so listApps returns real families (non-synthetic).
    await upsertApp(db as any, { slug: 'attribution', display_name: 'Attribution' })
    await upsertApp(db as any, { slug: 'platform', display_name: 'OAuth' })
    await upsertApp(db as any, { slug: 'checkout', display_name: 'Checkout' })

    // Seed PR entity cache with known file paths.
    // PR #171: only touches attribution
    await upsertEntity(db as any, {
      repo: 'o/r',
      kind: 'pr',
      number: 171,
      title: 'feat: attribution tracking fix (#171)',
      state: 'MERGED',
      author: 'dev-a',
      labels: [],
      updatedAt: 1000,
      closes: [],
      url: 'u171',
      files: ['apps/attribution/backend/src/track.ts'],
    })

    // PR #172: only touches platform
    await upsertEntity(db as any, {
      repo: 'o/r',
      kind: 'pr',
      number: 172,
      title: 'fix: platform consent banner flicker (#172)',
      state: 'MERGED',
      author: 'dev-b',
      labels: [],
      updatedAt: 1000,
      closes: [],
      url: 'u172',
      files: ['apps/platform/web/consent-banner.ts'],
    })

    // PR #200: no files -> unknown -> kept everywhere
    await upsertEntity(db as any, {
      repo: 'o/r',
      kind: 'pr',
      number: 200,
      title: 'chore: untracked infra change (#200)',
      state: 'MERGED',
      author: 'dev-c',
      labels: [],
      updatedAt: 1000,
      closes: [],
      url: 'u200',
      // files omitted -> files_json = NULL
    })

    // Drive the backfill
    const source = new BackfillAttributionTestSource()
    const result = await runBackfillWithSource(db as any, TEST_CONFIG, source)

    // Sanity: backfill ran and produced at least one release + note
    expect(result.releasesUpserted).toBeGreaterThan(0)

    // Path-scoping gate: checkout only gets PR #200 (unknown files -> kept).
    // PRs #171 (attribution) and #172 (platform) do NOT scope to checkout.
    expect(await notesFor(db, 'checkout')).toEqual([200])
  })
})
