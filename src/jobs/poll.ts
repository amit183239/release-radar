/**
 * The steady-state poll tick (§2). Cron-driven, resumable, self-healing:
 * every tick re-scans state, so a missed tag/PR is picked up next tick and
 * re-scans are no-ops (idempotent upserts). Guarded by a cron_locks singleton
 * so overlapping ticks can't double-process a chain.
 *
 * Steady-state only handles tags NEWER than each app's stored last_ref; full
 * history is a separate bootstrap (jobs/backfill.ts). An app with no last_ref
 * is initialized to its newest tag here (start tracking now) and left for the
 * backfill to fill in.
 */
import type { Env } from '../env'
import { resolveConfig, tagRegexAnyApp, type AppConfig } from '../config'
import {
  GitHubClient,
  type ResolvedTag,
  type CompareResult,
  type PullRequestNode,
  type IssueNode,
} from '../lib/github'
import { buildChain, enumeratePrNumbers, isDivergent, parseSquashPr } from '../lib/tags'
import { parseMapping, deriveFamilies } from '../lib/app-scoping'
import { acquireLock, releaseLock } from '../lib/cron-locks'
import { extractReleaseNote } from '../lib/release-notes'
import { prefetchPair, attributePr, type AttributeCtx } from './attribute'
import { nowSeconds } from '../lib/helpers'
import { QueryBudget } from '../lib/budget'
import {
  listQueryFollows,
  recordActivityEvent,
  fanOutActivity,
  type ActivityPayload,
} from '../lib/events'
import { detectActivity, type Activity } from '../lib/activity'
import {
  SYNC_OVERLAP_SECONDS,
  epochToCursor,
  normalizeCursor,
  nextSyncCursor,
} from '../lib/sync-cursor'
import {
  listApps,
  upsertApp,
  advanceLastRef,
  upsertRelease,
  upsertEntity,
  getEntitiesPrior,
  getSyncState,
  setSyncState,
} from '../lib/queries'

/** The GitHub surface the poll needs; GitHubClient satisfies it, and the DEBUG
 *  fixture source implements it for offline replay. */
export interface PollSource {
  getContent(
    path: string,
    etag?: string | null
  ): Promise<{ notModified: boolean; etag: string | null; text: string | null }>
  fetchTagsPage(cursor: string | null): Promise<{
    items: ResolvedTag[]
    hasNextPage: boolean
    endCursor: string | null
  }>
  compare(base: string, head: string): Promise<CompareResult>
  searchPullRequestsPage(
    updatedSinceISO: string,
    cursor: string | null
  ): Promise<{
    items: PullRequestNode[]
    hasNextPage: boolean
    endCursor: string | null
  }>
  searchIssuesPage(
    updatedSinceISO: string,
    cursor: string | null
  ): Promise<{ items: IssueNode[]; hasNextPage: boolean; endCursor: string | null }>
}

export interface PollResult {
  skipped?: string
  appsSeeded?: number
  releasesUpserted?: number
  notesUpserted?: number
  entitiesUpserted?: number
  feedItemsCreated?: number
  issuesUpserted?: number
  activityItemsCreated?: number
  /** True when the tick stopped early because the D1 query budget was spent. */
  budgetExhausted?: boolean
}

// Caps (review V14): bound work per tick so a first sweep can't blow the
// 5,000 req/hr budget. Steady-state new-tag volume is well under these.
const TAG_PAGE_CAP = 5 // 100 tags/page
const ENTITY_PAGE_CAP = 5 // 50 PRs/page
const LOCK_TTL_SECONDS = 55 * 60 // < the hourly cron interval

const MAPPING_ETAG_KEY = 'mapping-etag'
const ENTITY_CURSOR_KEY = 'pr-search'
const ISSUE_PAGE_CAP = 2 // conservative: keep headroom under the req/hr budget
const ISSUE_CURSOR_KEY = 'issue-search'

export async function runPoll(env: Env): Promise<PollResult> {
  const config = resolveConfig(env)
  const source = new GitHubClient(env.GITHUB_TOKEN, config.ownerRepo)
  return runPollWithSource(env.DB, config, source)
}

/** Testable core — inject any PollSource (real client or fixture). */
export async function runPollWithSource(
  db: D1Database,
  config: AppConfig,
  source: PollSource,
  budget: QueryBudget = new QueryBudget()
): Promise<PollResult> {
  const lock = await acquireLock(db, 'poll', LOCK_TTL_SECONDS)
  if (!lock.acquired) return { skipped: 'locked' }
  try {
    const appsSeeded = await refreshAppRegistry(db, config, source)
    // Sync the entity cache BEFORE processing tags so curated `## Release Note`
    // copy + `closes #N` linkage are available when notes/fan-out are created.
    const ents = await syncEntities(db, config, source, budget)
    const iss = await syncIssues(db, config, source, budget)
    const tagCounts = await processTags(db, config, source, budget)
    return {
      appsSeeded,
      entitiesUpserted: ents.upserted,
      issuesUpserted: iss.upserted,
      activityItemsCreated: ents.activityItems + iss.activityItems,
      ...tagCounts,
    }
  } finally {
    await releaseLock(db, 'poll', lock.token!)
  }
}

/**
 * Conditionally refresh the app registry from mapping.json. On a 304 nothing
 * changes. On new content, re-derive app families and upsert them plus the
 * synthetic shared-lib bucket. Returns the number of app rows written.
 */
async function refreshAppRegistry(
  db: D1Database,
  config: AppConfig,
  source: PollSource
): Promise<number> {
  const prior = await getSyncState(db, MAPPING_ETAG_KEY)
  const { notModified, etag, text } = await source.getContent(
    config.mappingPath,
    prior?.cursor ?? null
  )
  if (notModified || !text) return 0

  const mapping = parseMapping(text)
  const families = deriveFamilies(mapping)
  for (const fam of families) {
    await upsertApp(db, {
      slug: fam.slug,
      display_name: fam.slug,
      source_paths: fam.paths,
    })
  }
  // Register the synthetic shared-lib umbrella bucket (not a mapping slug).
  await upsertApp(db, {
    slug: config.sharedLibBucket,
    display_name: config.sharedLibBucket,
    synthetic: true,
  })
  await setSyncState(db, MAPPING_ETAG_KEY, etag, 'ok')
  return families.length + 1
}

/** Estimated D1 queries for one compare pair: upsertRelease + advanceLastRef +
 *  2 prefetch IN-queries per 90 PRs, then per PR: upsertNote, recordShipEvent,
 *  followerMatches, ~1 feed insert. */
function pairQueryCost(prCount: number): number {
  return 2 + 2 * Math.ceil(prCount / 90) + 4 * prCount
}

/**
 * Fetch capped tag pages, bucket prod tags by app (via the tag pattern's app
 * capture), chain each app's new tags, three-dot-compare each pair, and upsert
 * releases + fallback notes. last_ref advances per pair (each pair commits its
 * release + notes before it moves), PR attribution goes through the shared
 * attributePr, and the loop stops cleanly between pairs when the QueryBudget is
 * spent (the first pair of a tick always runs to guarantee progress).
 */
async function processTags(
  db: D1Database,
  config: AppConfig,
  source: PollSource,
  budget: QueryBudget
): Promise<{
  releasesUpserted: number
  notesUpserted: number
  feedItemsCreated: number
  budgetExhausted: boolean
}> {
  const apps = await listApps(db)
  const appBySlug = new Map(apps.map((a) => [a.slug, a]))
  const familySet = new Set(apps.filter((a) => !a.synthetic).map((a) => a.slug))
  const anyAppRe = tagRegexAnyApp(config.tagPattern)
  // Query follows are loaded ONCE per tick and matched in JS per shipped PR.
  const ctx: AttributeCtx = { config, familySet, queryFollows: await listQueryFollows(db) }
  budget.spend(1)

  // Collect matched prod tags across capped pages, grouped by app slug.
  const tagsByApp = new Map<string, ResolvedTag[]>()
  let cursor: string | null = null
  for (let page = 0; page < TAG_PAGE_CAP; page++) {
    const { items, hasNextPage, endCursor } = await source.fetchTagsPage(cursor)
    for (const tag of items) {
      const m = anyAppRe.exec(tag.name)
      if (!m) continue
      const appSlug = m[1]!
      if (!tagsByApp.has(appSlug)) tagsByApp.set(appSlug, [])
      tagsByApp.get(appSlug)!.push(tag)
    }
    if (!hasNextPage || !endCursor) break
    cursor = endCursor
  }

  let releasesUpserted = 0
  let notesUpserted = 0
  let feedItemsCreated = 0
  let pairsDone = 0
  let budgetExhausted = false

  for (const [appSlug, appTags] of tagsByApp) {
    if (budgetExhausted) break
    // Ensure an app row exists even for a tag app not in mapping (keeps the
    // changelog complete rather than silently dropping the deploy).
    if (!appBySlug.has(appSlug) && !familySet.has(appSlug)) {
      await upsertApp(db, { slug: appSlug, display_name: appSlug })
    }
    const app = appBySlug.get(appSlug)
    const sinceAt = app?.last_ref_at ?? null

    let pairs = buildChain(appTags, sinceAt)
    if (pairs.length === 0) continue
    // First-ever tracking for this app: initialize on the newest tag only and
    // leave history to the backfill job.
    if (sinceAt === null && pairs.length > 1) {
      pairs = [pairs[pairs.length - 1]!]
    }

    for (const pair of pairs) {
      // The first pair of a tick always runs (guarantees progress); after that,
      // stop cleanly between pairs once the D1 budget is spent.
      if (pairsDone > 0 && budget.exhausted) {
        budgetExhausted = true
        break
      }
      let prTitles = new Map<number, string>()
      let divergent = false

      if (pair.baseSha) {
        const cmp = await source.compare(pair.baseSha, pair.headSha)
        divergent = isDivergent(cmp.status)
        prTitles = titlesByPr(cmp)
      }
      const cost = pairQueryCost(prTitles.size)
      if (pairsDone > 0 && budget.remaining < cost) {
        budgetExhausted = true
        break
      }
      if (pairsDone === 0 && budget.remaining < cost) {
        // Progress guarantee: the first pair runs even though it is estimated
        // to exceed the remaining budget. Surface it for tuning.
        console.warn(
          `[poll] first pair exceeds budget: app=${appSlug} tag=${pair.tag} estimatedCost=${cost} remaining=${budget.remaining}`
        )
      }

      const releaseId = await upsertRelease(db, {
        app: appSlug,
        ref: pair.headSha,
        tag: pair.tag,
        deployedAt: pair.deployedAt,
        baseRef: pair.baseSha,
        divergent,
      })
      releasesUpserted++

      let pairFeedItems = 0
      const pre = await prefetchPair(db, config.ownerRepo, [...prTitles.keys()])
      for (const [prNumber, title] of prTitles) {
        const r = await attributePr(db, ctx, pre, {
          releaseId,
          app: appSlug,
          prNumber,
          title,
          fanOut: true,
        })
        if (!r.attributed) continue
        notesUpserted++
        feedItemsCreated += r.feedItemsCreated
        pairFeedItems += r.feedItemsCreated
      }

      // Advance per committed pair (partial-tick safety; idempotent re-scans).
      await advanceLastRef(db, appSlug, pair.headSha, pair.deployedAt)
      // The pre-pair gate uses the estimate (assumes ~1 feed insert per PR), but
      // fanOutShip does one INSERT per matched follower: charge the estimate
      // minus that assumption plus the ACTUAL feed inserts.
      budget.spend(cost - prTitles.size + pairFeedItems)
      pairsDone++
    }
  }

  if (budgetExhausted) {
    console.log(JSON.stringify({ msg: 'poll: D1 query budget spent; resuming next tick', pairsDone }))
  }
  return { releasesUpserted, notesUpserted, feedItemsCreated, budgetExhausted }
}

/** Map each PR number in a compare to its squash subject (minus the `(#N)`). */
function titlesByPr(cmp: CompareResult): Map<number, string> {
  const map = new Map<number, string>()
  for (const c of cmp.commits) {
    const pr = parseSquashPr(c.message)
    if (pr === null || map.has(pr)) continue
    const subject = c.message.split('\n', 1)[0] ?? ''
    map.set(pr, subject.replace(/\s*\(#\d+\)\s*$/, '').trim())
  }
  // Preserve first-seen order used elsewhere (enumeratePrNumbers) — Map keeps
  // insertion order, so this already matches.
  void enumeratePrNumbers
  return map
}

/**
 * Record one re-surface activity event and fan it out (spec §2c). Called BEFORE
 * the entity upsert so a crash re-detects next tick under the same dedupe key.
 * Returns feed rows created.
 */
async function emitActivity(
  db: D1Database,
  budget: QueryBudget,
  a: {
    kind: 'issue' | 'pr'
    number: number
    updatedAt: number
    title: string | null
    url: string | null
    entityId: string
    activity: Activity
  }
): Promise<number> {
  const payload: ActivityPayload = {
    entity_kind: a.kind,
    number: a.number,
    title: a.title,
    url: a.url,
    ...(a.activity.stateTo !== undefined ? { state_from: a.activity.stateFrom, state_to: a.activity.stateTo } : {}),
    ...(a.activity.newComments !== undefined ? { new_comments: a.activity.newComments } : {}),
  }
  const eventId = await recordActivityEvent(db, {
    entityId: a.entityId,
    prNumber: a.kind === 'pr' ? a.number : null,
    dedupeKey: `activity:${a.kind}:${a.number}:${a.updatedAt}`,
    payload,
  })
  const created = await fanOutActivity(db, { eventId, entityKind: a.kind, number: a.number })
  budget.spend(2 + created) // event insert + follower select + one insert per follower
  return created
}

/**
 * Populate the PR entity cache from an `updated:>=<cursor>` search window (the
 * cursor is a UTC timestamp; see sync-cursor.ts). Feeds `closes #N` linkage (CX
 * lens) and the follow/re-surface primitives. Per item the order is: read the
 * prior entity row -> emit an activity event + follower fan-out (if meaningful)
 * -> upsert. The cursor advances only from OBSERVED updatedAt values (never
 * wall-clock), minus a short overlap, and never backward.
 */
async function syncEntities(
  db: D1Database,
  config: AppConfig,
  source: PollSource,
  budget: QueryBudget
): Promise<{ upserted: number; activityItems: number }> {
  const prior = await getSyncState(db, ENTITY_CURSOR_KEY)
  // Timestamp cursor (`updated:>=`); a legacy date-only cursor normalizes to
  // midnight UTC. First run: a bounded 30-day window.
  const priorCursor = normalizeCursor(prior?.cursor)
  const sinceISO = priorCursor ?? epochToCursor(nowSeconds() - 30 * 86_400)

  let cursor: string | null = null
  let count = 0
  let activityItems = 0
  // Max updatedAt OBSERVED this tick only — never seeded from last_synced_at.
  let maxSeen: number | null = null
  let capped = false
  for (let page = 0; page < ENTITY_PAGE_CAP; page++) {
    if (budget.exhausted) break
    const { items, hasNextPage, endCursor } = await source.searchPullRequestsPage(
      sinceISO,
      cursor
    )
    // (1) Read prior rows for the whole page BEFORE writing anything.
    const priors = await getEntitiesPrior(db, config.ownerRepo, 'pr', items.map((p) => p.number))
    budget.spend(Math.ceil(items.length / 90))
    for (const pr of items) {
      const before = priors.get(pr.number)
      const activity = detectActivity(before, { state: pr.state, commentsCount: pr.commentsCount ?? null })
      // (2) Event + fan-out BEFORE the upsert (crash re-detects under same dedupe key).
      if (activity && before) {
        activityItems += await emitActivity(db, budget, {
          kind: 'pr',
          number: pr.number,
          updatedAt: pr.updatedAt,
          title: pr.title,
          url: pr.url,
          entityId: before.id,
          activity,
        })
      }
      // (3) Extract curated `## Release Note` copy from the body (skip marker
      // yields no curated note); stored so processTags can prefer ● over ○.
      const rn = extractReleaseNote(pr.body)
      await upsertEntity(db, {
        repo: config.ownerRepo,
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.authorLogin,
        labels: pr.labels,
        closes: pr.closesIssues,
        updatedAt: pr.updatedAt,
        url: pr.url,
        milestone: pr.milestone ?? null,
        releaseNote: rn.curated,
        files: pr.files,
        commentsCount: pr.commentsCount ?? null,
        lastMeaningfulActivityAt: activity ? pr.updatedAt : null,
      })
      budget.spend(1)
      count++
      if (maxSeen === null || pr.updatedAt > maxSeen) maxSeen = pr.updatedAt
    }
    // True only if the LAST page fetched still had more — i.e. the cap was hit.
    capped = hasNextPage && endCursor !== null
    if (!capped) break
    cursor = endCursor
  }

  const nextCursor =
    nextSyncCursor({ prior: priorCursor, maxSeen, overlapSeconds: SYNC_OVERLAP_SECONDS, capped }) ??
    sinceISO
  await setSyncState(db, ENTITY_CURSOR_KEY, nextCursor, 'ok')
  return { upserted: count, activityItems }
}

/** Ingest issues into the entity cache (kind='issue') so they can be browsed +
 *  followed. Same shape as the PR sweep: `updated:>=` timestamp cursor, per item
 *  read-prior -> activity event + fan-out -> upsert, cursor advanced only from
 *  observed updatedAt (observed-only) minus a short overlap, since issue state
 *  churns faster than merged PRs. */
async function syncIssues(
  db: D1Database,
  config: AppConfig,
  source: PollSource,
  budget: QueryBudget
): Promise<{ upserted: number; activityItems: number }> {
  const prior = await getSyncState(db, ISSUE_CURSOR_KEY)
  const priorCursor = normalizeCursor(prior?.cursor)
  const sinceISO = priorCursor ?? epochToCursor(nowSeconds() - 30 * 86_400)

  let cursor: string | null = null
  let count = 0
  let activityItems = 0
  let maxSeen: number | null = null
  let capped = false
  for (let page = 0; page < ISSUE_PAGE_CAP; page++) {
    if (budget.exhausted) break
    const { items, hasNextPage, endCursor } = await source.searchIssuesPage(sinceISO, cursor)
    const priors = await getEntitiesPrior(db, config.ownerRepo, 'issue', items.map((i) => i.number))
    budget.spend(Math.ceil(items.length / 90))
    for (const iss of items) {
      const before = priors.get(iss.number)
      const activity = detectActivity(before, { state: iss.state, commentsCount: iss.commentsCount ?? null })
      if (activity && before) {
        activityItems += await emitActivity(db, budget, {
          kind: 'issue',
          number: iss.number,
          updatedAt: iss.updatedAt,
          title: iss.title,
          url: iss.url,
          entityId: before.id,
          activity,
        })
      }
      await upsertEntity(db, {
        repo: config.ownerRepo,
        kind: 'issue',
        number: iss.number,
        title: iss.title,
        state: iss.state,
        author: null,
        labels: iss.labels,
        closes: [],
        updatedAt: iss.updatedAt,
        url: iss.url,
        milestone: iss.milestone,
        issueType: iss.issueType ?? null,
        commentsCount: iss.commentsCount ?? null,
        lastMeaningfulActivityAt: activity ? iss.updatedAt : null,
      })
      budget.spend(1)
      count++
      if (maxSeen === null || iss.updatedAt > maxSeen) maxSeen = iss.updatedAt
    }
    capped = hasNextPage && endCursor !== null
    if (!capped) break
    cursor = endCursor
  }
  // Same overlap as the PR sweep (the old 1-hour issue overlap was a no-op
  // after date truncation — the source of the same-day-close bug).
  const nextCursor =
    nextSyncCursor({ prior: priorCursor, maxSeen, overlapSeconds: SYNC_OVERLAP_SECONDS, capped }) ??
    sinceISO
  await setSyncState(db, ISSUE_CURSOR_KEY, nextCursor, 'ok')
  return { upserted: count, activityItems }
}
