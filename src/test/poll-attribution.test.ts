/**
 * TDD test for Task 4: per-PR path-scoping gate in processTags.
 *
 * Fixture setup:
 *   - 3 apps: attribution, platform, checkout (all in mapping + app registry)
 *   - shared lib bucket: "platform" (the synthetic umbrella; coincides with the
 *     platform family slug, which is correct for shared-lib PRs).
 *   - PR #171 files: apps/attribution/** -> scopes to "attribution" only
 *   - PR #172 files: apps/platform/**    -> scopes to "platform" only
 *   - PR #200 files: none (null)        -> unknown, kept everywhere
 *
 * Expected notes after runPollWithSource:
 *   attribution -> [171, 200]
 *   platform     -> [172, 200]
 *   checkout    -> [200]         (neither 171 nor 172 scope to checkout)
 */
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity } from '../lib/queries'
import { runPollWithSource, type PollSource } from '../jobs/poll'
import type { AppConfig } from '../config'
import type { ResolvedTag, CompareResult } from '../lib/github'

// ---------------------------------------------------------------------------
// Mapping JSON with families: attribution, platform, checkout
// ---------------------------------------------------------------------------
const MAPPING_JSON = JSON.stringify({
  projects: {
    'attribution-backend': 'apps/attribution/backend',
    'attribution-worker': 'apps/attribution/worker',
    'platform-api': 'apps/platform/api',
    'platform-web': 'apps/platform/web',
    'checkout-api': 'apps/checkout/api',
  },
})

// ---------------------------------------------------------------------------
// Tag pattern: "{app}-v{version}-production"
// e.g. attribution-v2.1.0-production
// ---------------------------------------------------------------------------
const TAG_PATTERN = '{app}-v*-production'

// ---------------------------------------------------------------------------
// Shared SHAs
// ---------------------------------------------------------------------------
const BASE_SHA_ATT = 'base-attribution-sha'
const BASE_SHA_EDT = 'base-platform-sha'
const BASE_SHA_CHK = 'base-checkout-sha'
const HEAD_SHA = 'head-sha-v210'

// ---------------------------------------------------------------------------
// Commits in the compare range: PRs #171, #172, #200
// Three squash-commit subjects (anchored `(#N)` suffix).
// ---------------------------------------------------------------------------
const COMMITS_171_172_200 = [
  { message: 'feat: attribution tracking fix (#171)\n\nbody', sha: 'c171', authorLogin: null },
  { message: 'fix: platform consent banner flicker (#172)\n\nbody', sha: 'c172', authorLogin: null },
  { message: 'chore: untracked infra change (#200)\n\nbody', sha: 'c200', authorLogin: null },
]

// ---------------------------------------------------------------------------
// A minimal PollSource stub for this test.
// Provides: getContent (mapping), fetchTagsPage (3 app tags), compare (shared)
// Does NOT provide entities (we seed those directly via upsertEntity).
// ---------------------------------------------------------------------------
class AttributionTestSource implements PollSource {
  async getContent(_path: string, _etag?: string | null) {
    return { notModified: false, etag: 'etag-1', text: MAPPING_JSON }
  }

  async fetchTagsPage(_cursor: string | null): Promise<{
    items: ResolvedTag[]
    hasNextPage: boolean
    endCursor: string | null
  }> {
    // One page with three app prod tags, each with a prior base.
    // createdAt (tagger.date) drives deploy order (epoch seconds).
    const tags: ResolvedTag[] = [
      {
        name: 'attribution-v2.1.0-production',
        commitSha: HEAD_SHA,
        createdAt: 2000,
        lightweight: false,
      },
      {
        name: 'attribution-v2.0.0-production',
        commitSha: BASE_SHA_ATT,
        createdAt: 1000,
        lightweight: false,
      },
      {
        name: 'platform-v2.1.0-production',
        commitSha: HEAD_SHA,
        createdAt: 2000,
        lightweight: false,
      },
      {
        name: 'platform-v2.0.0-production',
        commitSha: BASE_SHA_EDT,
        createdAt: 1000,
        lightweight: false,
      },
      {
        name: 'checkout-v2.1.0-production',
        commitSha: HEAD_SHA,
        createdAt: 2000,
        lightweight: false,
      },
      {
        name: 'checkout-v2.0.0-production',
        commitSha: BASE_SHA_CHK,
        createdAt: 1000,
        lightweight: false,
      },
    ]
    return { items: tags, hasNextPage: false, endCursor: null }
  }

  async compare(base: string, _head: string): Promise<CompareResult> {
    // Return the same commits for all three app ranges.
    // (base differs per app so we don't collide, head is shared HEAD_SHA.)
    if (
      base === BASE_SHA_ATT ||
      base === BASE_SHA_EDT ||
      base === BASE_SHA_CHK
    ) {
      return {
        status: 'ahead',
        files: [], // compare-level files (not used for scoping — per-PR files come from entity cache)
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
    // No entity sync needed — we seed the PR cache directly.
    return { items: [], hasNextPage: false, endCursor: null }
  }

  async searchIssuesPage(_updatedSinceISO: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
}

// ---------------------------------------------------------------------------
// Minimal AppConfig for the test (no auth, no AI, no real secrets).
// ---------------------------------------------------------------------------
const TEST_CONFIG: AppConfig = {
  owner: 'o',
  repo: 'r',
  ownerRepo: 'o/r',
  mappingPath: '.github/mapping.json',
  allowedDomains: ['example.com'],
  sharedLibBucket: 'platform', // shared-lib PRs land here
  backfillDays: 7,
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
// Multi-app PR test fixtures
// ---------------------------------------------------------------------------
const MAPPING_JSON_MULTI = JSON.stringify({
  projects: {
    'billing-backend': 'apps/billing/backend',
    'billing-worker': 'apps/billing/worker',
    'checkout-api': 'apps/checkout/api',
    'platform-api': 'apps/platform/api',
    'platform-web': 'apps/platform/web',
  },
})

// PR #301 touches both billing AND checkout — spans two apps.
const COMMITS_301 = [
  { message: 'feat: shared promo engine (#301)\n\nbody', sha: 'c301', authorLogin: null },
]

const BASE_SHA_AFL = 'base-billing-sha'
const BASE_SHA_CHK2 = 'base-checkout2-sha'
const BASE_SHA_EDT2 = 'base-platform2-sha'
const HEAD_SHA_MULTI = 'head-sha-multi'

class MultiAppTestSource implements PollSource {
  async getContent(_path: string, _etag?: string | null) {
    return { notModified: false, etag: 'etag-multi', text: MAPPING_JSON_MULTI }
  }

  async fetchTagsPage(_cursor: string | null): Promise<{
    items: ResolvedTag[]
    hasNextPage: boolean
    endCursor: string | null
  }> {
    const tags: ResolvedTag[] = [
      // billing tag pair
      {
        name: 'billing-v3.1.0-production',
        commitSha: HEAD_SHA_MULTI,
        createdAt: 2000,
        lightweight: false,
      },
      {
        name: 'billing-v3.0.0-production',
        commitSha: BASE_SHA_AFL,
        createdAt: 1000,
        lightweight: false,
      },
      // checkout tag pair
      {
        name: 'checkout-v3.1.0-production',
        commitSha: HEAD_SHA_MULTI,
        createdAt: 2000,
        lightweight: false,
      },
      {
        name: 'checkout-v3.0.0-production',
        commitSha: BASE_SHA_CHK2,
        createdAt: 1000,
        lightweight: false,
      },
      // platform tag pair (unrelated — its compare range also enumerates #301
      // but #301's files don't scope to platform, so no note must be created)
      {
        name: 'platform-v3.1.0-production',
        commitSha: HEAD_SHA_MULTI,
        createdAt: 2000,
        lightweight: false,
      },
      {
        name: 'platform-v3.0.0-production',
        commitSha: BASE_SHA_EDT2,
        createdAt: 1000,
        lightweight: false,
      },
    ]
    return { items: tags, hasNextPage: false, endCursor: null }
  }

  async compare(base: string, _head: string): Promise<CompareResult> {
    if (
      base === BASE_SHA_AFL ||
      base === BASE_SHA_CHK2 ||
      base === BASE_SHA_EDT2
    ) {
      return {
        status: 'ahead',
        files: [],
        commits: COMMITS_301,
        truncated: false,
      }
    }
    throw new Error(`fixture: unexpected compare base: ${base}`)
  }

  async searchPullRequestsPage(_updatedSinceISO: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }

  async searchIssuesPage(_updatedSinceISO: string, _cursor: string | null) {
    return { items: [], hasNextPage: false, endCursor: null }
  }
}

const TEST_CONFIG_MULTI: AppConfig = {
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
  tagPattern: TAG_PATTERN,
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------
describe('processTags path-scoped attribution', () => {
  it('attributes each PR only to the app its files scope to; unknown files kept', async () => {
    const db = makeTestDb()

    // Seed PR entity cache with known file paths (files = path-scoped)
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

    // Drive the full poll
    const source = new AttributionTestSource()
    await runPollWithSource(db as any, TEST_CONFIG, source)

    // Assertions: path-scoping gate + unknown-files fallthrough
    expect(await notesFor(db, 'attribution')).toEqual([171, 200])
    expect(await notesFor(db, 'platform')).toEqual([172, 200])
    expect(await notesFor(db, 'checkout')).toEqual([200])
  })

  it('attributes a multi-app PR to each app its files scope to, and not to an unrelated app', async () => {
    const db = makeTestDb()

    // PR #301: files span billing AND checkout — must land in both.
    await upsertEntity(db as any, {
      repo: 'o/r',
      kind: 'pr',
      number: 301,
      title: 'feat: shared promo engine (#301)',
      state: 'MERGED',
      author: 'dev-x',
      labels: [],
      updatedAt: 2000,
      closes: [],
      url: 'u301',
      files: ['apps/billing/backend/promo.ts', 'apps/checkout/api/cart.ts'],
    })

    const source = new MultiAppTestSource()
    await runPollWithSource(db as any, TEST_CONFIG_MULTI, source)

    // PR #301 touches billing -> billing release gets a note
    expect(await notesFor(db, 'billing')).toEqual([301])
    // PR #301 touches checkout -> checkout release gets a note
    expect(await notesFor(db, 'checkout')).toEqual([301])
    // PR #301 does NOT touch platform -> platform release must NOT get a note
    expect(await notesFor(db, 'platform')).toEqual([])
  })
})
