/**
 * Shared per-PR attribution — the ONE path the poll and the backfill both use
 * (spec §0d). Per compare pair, `prefetchPair` loads the cached PRs and the
 * union of their closed issues in a couple of IN-queries (D1 budget, §0e);
 * `attributePr` then applies, per PR: path-scope gate → curated/fallback note →
 * customer_facing → upsertNote → recordShipEvent → (optionally) fan-out.
 *
 * Poll passes `fanOut: true`. Backfill passes `fanOut: false`: history gets ship
 * events (so follow-backfill and matchers can see it) without unread spam.
 */
import type { AppConfig } from '../config'
import { prScopesToApp } from '../lib/app-scoping'
import { classifyCustomerFacing } from '../lib/customer-facing'
import { recordShipEvent, fanOutShip, type QueryFollow } from '../lib/events'
import { parseJsonArray } from '../lib/json'
import {
  getCachedPrs,
  getIssuesByNumbers,
  upsertNote,
  type CachedPr,
  type CachedIssue,
} from '../lib/queries'

export interface PairPrefetch {
  prs: Map<number, CachedPr>
  issues: Map<number, CachedIssue>
}

export interface AttributeCtx {
  config: AppConfig
  familySet: Set<string>
  queryFollows: QueryFollow[]
}

export interface AttributeResult {
  attributed: boolean
  feedItemsCreated: number
}

/** Load the pair's cached PRs + the union of their closed issues (2 IN-queries). */
export async function prefetchPair(
  db: D1Database,
  repo: string,
  prNumbers: number[]
): Promise<PairPrefetch> {
  if (prNumbers.length === 0) return { prs: new Map(), issues: new Map() }
  const prs = await getCachedPrs(db, repo, prNumbers)
  const issueNumbers = new Set<number>()
  for (const pr of prs.values()) {
    for (const n of parseJsonArray<number>(pr.closes_json)) issueNumbers.add(n)
  }
  const issues =
    issueNumbers.size > 0
      ? await getIssuesByNumbers(db, repo, [...issueNumbers])
      : new Map<number, CachedIssue>()
  return { prs, issues }
}

export async function attributePr(
  db: D1Database,
  ctx: AttributeCtx,
  pre: PairPrefetch,
  p: { releaseId: string; app: string; prNumber: number; title: string; fanOut: boolean }
): Promise<AttributeResult> {
  const { config, familySet } = ctx
  const cached = pre.prs.get(p.prNumber) ?? null

  // Per-PR path scoping: attribute this PR to the tag app only if its own files
  // scope here. Unknown/empty files -> keep (decision 1). Shared-lib files ->
  // platform umbrella only (decision 2, via scopeFilesToApps).
  const prFiles = parseJsonArray<string>(cached?.files_json)
  const filesKnown = cached?.files_json != null && prFiles.length > 0
  if (filesKnown && !prScopesToApp(prFiles, p.app, familySet, config.sharedLibBucket)) {
    return { attributed: false, feedItemsCreated: 0 }
  }

  // Curated (●) copy from the PR's `## Release Note` if cached, else the
  // from-PR-title fallback (○). upsertNote never downgrades a human note.
  const curated = cached?.release_note ?? null
  const labels = parseJsonArray<string>(cached?.labels_json)
  const closes = parseJsonArray<number>(cached?.closes_json)
  const closedIssues = closes
    .map((n) => pre.issues.get(n))
    .filter((i): i is CachedIssue => i != null)
  // cfLabels (PR + closed issues) feed ONLY the classifier. Label-follow fan-out
  // keeps the PR's own labels (consistent with matchesFor / backfillFollowFeed).
  const cfLabels = [
    ...labels,
    ...closedIssues.flatMap((i) => parseJsonArray<string>(i.labels_json)),
  ]
  const issueTypes = closedIssues
    .map((i) => i.issue_type)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
  // Milestone follows match the PR's milestone OR any closed issue's (exact).
  const milestones = [
    ...new Set(
      [cached?.milestone ?? null, ...closedIssues.map((i) => i.milestone)].filter(
        (m): m is string => typeof m === 'string' && m.length > 0
      )
    ),
  ]
  // customer_facing is fail-closed: false unless a configured label or issue
  // type matches (§3). Issues missing from the cache contribute nothing.
  const customerFacing = classifyCustomerFacing({
    labels: cfLabels,
    customerFacingLabels: config.customerFacingLabels,
    issueTypes,
    customerFacingIssueTypes: config.customerFacingIssueTypes,
  })
  const stored = await upsertNote(db, {
    releaseId: p.releaseId,
    app: p.app,
    prNumber: p.prNumber,
    noteTechnical: curated ?? p.title,
    copySource: curated ? 'human' : 'fallback',
    customerFacing,
    author: cached?.author ?? null,
    url: cached?.url ?? null,
  })

  // Ship event (idempotent) — recorded for poll AND backfill.
  const eventId = await recordShipEvent(db, {
    app: p.app,
    releaseId: p.releaseId,
    prNumber: p.prNumber,
  })
  if (!p.fanOut) return { attributed: true, feedItemsCreated: 0 }

  const feedItemsCreated = await fanOutShip(db, {
    eventId,
    app: p.app,
    prNumber: p.prNumber,
    closesIssues: closes,
    prLabels: labels,
    // Query matching uses the STORED text so fan-out, search and read time agree.
    noteTechnical: stored.noteTechnical,
    queryFollows: ctx.queryFollows,
    milestones,
  })
  return { attributed: true, feedItemsCreated }
}
