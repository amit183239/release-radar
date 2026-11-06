/**
 * Backfill bootstrap (§2). A SEPARATE, one-time job (not the steady tick) that
 * imports capped history (BACKFILL_DAYS, default 90) by running the same
 * chained attribution. Spread across invocations via a per-app progress cursor
 * so a first run can't blow the 5,000 req/hr budget.
 *
 * It never advances the steady last_ref (the poll owns forward progress); its
 * release/note upserts are idempotent on their natural keys, so backfilled
 * history and live ticks coexist without conflict.
 *
 * Each in-window tag diffs against its IMMEDIATE chronological predecessor —
 * including one tag fetched from just BEFORE the window, to anchor the base of
 * the oldest in-window release.
 */
import type { Env } from '../env'
import { resolveConfig, tagRegexAnyApp, type AppConfig } from '../config'
import { GitHubClient, type ResolvedTag } from '../lib/github'
import { buildChain, isDivergent, parseSquashPr } from '../lib/tags'
import { acquireLock, releaseLock } from '../lib/cron-locks'
import { upsertRelease, getSyncState, setSyncState, listApps } from '../lib/queries'
import { prefetchPair, attributePr, type AttributeCtx } from './attribute'
import type { PollSource } from './poll'

const LOCK_TTL_SECONDS = 55 * 60
const TAG_PAGE_CAP = 40 // enough for the full 3.3k-tag list at 100/page
const COMPARE_CAP_PER_RUN = 100 // bound compare calls per invocation

export interface BackfillResult {
  skipped?: string
  releasesUpserted: number
  notesUpserted: number
  done: boolean
}

export async function runBackfill(env: Env): Promise<BackfillResult> {
  const config = resolveConfig(env)
  const source = new GitHubClient(env.GITHUB_TOKEN, config.ownerRepo)
  return runBackfillWithSource(env.DB, config, source)
}

export async function runBackfillWithSource(
  db: D1Database,
  config: AppConfig,
  source: PollSource
): Promise<BackfillResult> {
  const lock = await acquireLock(db, 'backfill', LOCK_TTL_SECONDS)
  if (!lock.acquired) {
    return { skipped: 'locked', releasesUpserted: 0, notesUpserted: 0, done: false }
  }
  try {
    return await backfill(db, config, source)
  } finally {
    await releaseLock(db, 'backfill', lock.token!)
  }
}

async function backfill(
  db: D1Database,
  config: AppConfig,
  source: PollSource
): Promise<BackfillResult> {
  const windowStart = Math.floor(Date.now() / 1000) - config.backfillDays * 86_400
  const anyAppRe = tagRegexAnyApp(config.tagPattern)

  // Collect all prod tags grouped by app.
  const tagsByApp = new Map<string, ResolvedTag[]>()
  let cursor: string | null = null
  for (let page = 0; page < TAG_PAGE_CAP; page++) {
    const { items, hasNextPage, endCursor } = await source.fetchTagsPage(cursor)
    for (const tag of items) {
      const m = anyAppRe.exec(tag.name)
      if (!m) continue
      const slug = m[1]!
      if (!tagsByApp.has(slug)) tagsByApp.set(slug, [])
      tagsByApp.get(slug)!.push(tag)
    }
    if (!hasNextPage || !endCursor) break
    cursor = endCursor
  }

  // Derive the family set once (mirrors processTags in poll.ts).
  const apps = await listApps(db)
  const familySet = new Set(apps.filter((a) => !a.synthetic).map((a) => a.slug))
  // Same attribution path as the poll, minus fan-out: history records ship
  // events (visible to follow-backfill + matchers) without unread spam.
  const ctx: AttributeCtx = { config, familySet, queryFollows: [] }

  let releasesUpserted = 0
  let notesUpserted = 0
  let compareBudget = COMPARE_CAP_PER_RUN
  let done = true

  for (const [appSlug, appTags] of tagsByApp) {
    if (compareBudget <= 0) {
      done = false
      break
    }
    // Resume from where a prior run stopped (progress = deployedAt processed).
    const progressKey = `backfill:${appSlug}`
    const prior = await getSyncState(db, progressKey)
    const processedThroughAt = prior?.last_synced_at ?? 0

    // Chain over ALL tags (sinceAt=null gives every pair with its predecessor
    // base — including the anchor from before the window). Then keep only pairs
    // that are in-window AND not yet processed.
    const allPairs = buildChain(appTags, null)
    const pending = allPairs.filter(
      (p) => p.deployedAt >= windowStart && p.deployedAt > processedThroughAt
    )
    if (pending.length === 0) continue

    let lastAt = processedThroughAt
    for (const pair of pending) {
      if (compareBudget <= 0) {
        done = false
        break
      }
      let divergent = false
      const prTitles = new Map<number, string>()
      if (pair.baseSha) {
        const cmp = await source.compare(pair.baseSha, pair.headSha)
        compareBudget--
        divergent = isDivergent(cmp.status)
        for (const c of cmp.commits) {
          const pr = parseSquashPr(c.message)
          if (pr === null || prTitles.has(pr)) continue
          const subject = c.message.split('\n', 1)[0] ?? ''
          prTitles.set(pr, subject.replace(/\s*\(#\d+\)\s*$/, '').trim())
        }
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
      const pre = await prefetchPair(db, config.ownerRepo, [...prTitles.keys()])
      for (const [prNumber, title] of prTitles) {
        const r = await attributePr(db, ctx, pre, {
          releaseId,
          app: appSlug,
          prNumber,
          title,
          fanOut: false,
        })
        if (r.attributed) notesUpserted++
      }
      lastAt = pair.deployedAt
    }

    // Persist progress so the next run resumes past what we finished.
    await setSyncState(db, progressKey, null, 'backfilling')
    await db
      .prepare(
        `UPDATE sync_state SET last_synced_at = ? WHERE key = ? AND (last_synced_at IS NULL OR last_synced_at < ?)`
      )
      .bind(lastAt, progressKey, lastAt)
      .run()
  }

  return { releasesUpserted, notesUpserted, done }
}

