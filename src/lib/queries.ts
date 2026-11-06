/**
 * D1 query layer. Every write is an idempotent upsert on its natural key so a
 * re-scan (the poll's self-healing property) is a no-op. Parameterized queries
 * only. Timestamps are epoch seconds (see helpers.nowSeconds).
 */
import { newId, nowSeconds, placeholdersFor } from './helpers'

// ---------------------------------------------------------------------------
// sync_state — cursor / etag store keyed by a logical stream name.
// ---------------------------------------------------------------------------
export interface SyncState {
  key: string
  cursor: string | null
  last_synced_at: number | null
  status: string | null
}

export async function getSyncState(
  db: D1Database,
  key: string
): Promise<SyncState | null> {
  return db
    .prepare('SELECT * FROM sync_state WHERE key = ?')
    .bind(key)
    .first<SyncState>()
}

export async function setSyncState(
  db: D1Database,
  key: string,
  cursor: string | null,
  status: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (key, cursor, last_synced_at, status)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         cursor = excluded.cursor,
         last_synced_at = excluded.last_synced_at,
         status = excluded.status`
    )
    .bind(key, cursor, nowSeconds(), status)
    .run()
}

// ---------------------------------------------------------------------------
// apps — registry seeded from mapping.json; last_ref advanced by the poll.
// ---------------------------------------------------------------------------
export interface AppRow {
  slug: string
  display_name: string
  repos_json: string | null
  source_paths_json: string | null
  label_override: string | null
  visibility: string
  synthetic: number
  last_ref: string | null
  last_ref_at: number | null
  created_at: number
}

export async function listApps(db: D1Database): Promise<AppRow[]> {
  const { results } = await db.prepare('SELECT * FROM apps').all<AppRow>()
  return results ?? []
}

export async function getApp(
  db: D1Database,
  slug: string
): Promise<AppRow | null> {
  return db.prepare('SELECT * FROM apps WHERE slug = ?').bind(slug).first<AppRow>()
}

/** Upsert an app registry row. On conflict, refresh mutable metadata but never
 *  clobber last_ref/last_ref_at (owned by the poll's advance path). */
export async function upsertApp(
  db: D1Database,
  app: {
    slug: string
    display_name: string
    source_paths?: string[]
    visibility?: string
    synthetic?: boolean
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO apps
         (slug, display_name, source_paths_json, visibility, synthetic, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         display_name = excluded.display_name,
         source_paths_json = excluded.source_paths_json,
         visibility = excluded.visibility,
         synthetic = excluded.synthetic`
    )
    .bind(
      app.slug,
      app.display_name,
      app.source_paths ? JSON.stringify(app.source_paths) : null,
      app.visibility ?? 'internal',
      app.synthetic ? 1 : 0,
      nowSeconds()
    )
    .run()
}

/**
 * Advance an app's last_ref ONLY forward in tag-creation time (partial-tick
 * safety + re-scan idempotence). A stale re-run with an older ref is a no-op.
 */
export async function advanceLastRef(
  db: D1Database,
  slug: string,
  ref: string,
  refAt: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE apps SET last_ref = ?, last_ref_at = ?
       WHERE slug = ? AND (last_ref_at IS NULL OR last_ref_at < ?)`
    )
    .bind(ref, refAt, slug, refAt)
    .run()
}

// ---------------------------------------------------------------------------
// releases — idempotent on (app, ref).
// ---------------------------------------------------------------------------
export interface UpsertRelease {
  app: string
  ref: string
  tag: string
  deployedAt: number
  baseRef: string | null
  divergent: boolean
}

/** Upsert a release; returns its id (existing id preserved on conflict). */
export async function upsertRelease(
  db: D1Database,
  r: UpsertRelease
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO releases
         (id, app, ref, tag, deployed_at, base_ref, divergent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app, ref) DO UPDATE SET
         tag = excluded.tag,
         deployed_at = excluded.deployed_at,
         base_ref = excluded.base_ref,
         divergent = excluded.divergent
       RETURNING id`
    )
    .bind(
      newId(),
      r.app,
      r.ref,
      r.tag,
      r.deployedAt,
      r.baseRef,
      r.divergent ? 1 : 0,
      nowSeconds()
    )
    .first<{ id: string }>()
  if (!row) throw new Error(`upsertRelease returned no id for ${r.app}/${r.ref}`)
  return row.id
}

// ---------------------------------------------------------------------------
// notes — idempotent on (release_id, pr_number). Never overwrite a curated
// (human) note with a fallback/ai one; that gate lives in the caller.
// ---------------------------------------------------------------------------
export interface UpsertNote {
  releaseId: string
  app: string
  prNumber: number
  noteTechnical: string | null
  noteCustomer?: string | null
  copySource: 'human' | 'ai' | 'fallback'
  customerFacing?: boolean
  author?: string | null
  mergedAt?: number | null
  url?: string | null
}

export async function upsertNote(
  db: D1Database,
  n: UpsertNote
): Promise<{ noteTechnical: string | null }> {
  const row = await db
    .prepare(
      `INSERT INTO notes
         (id, release_id, app, pr_number, note_technical, note_customer,
          copy_source, customer_facing, author, merged_at, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id, pr_number) DO UPDATE SET
         -- Never downgrade a curated (human) note with a later fallback/ai one.
         note_technical = CASE
           WHEN excluded.copy_source = 'human' OR notes.copy_source != 'human'
           THEN excluded.note_technical ELSE notes.note_technical END,
         copy_source = CASE
           WHEN excluded.copy_source = 'human' OR notes.copy_source != 'human'
           THEN excluded.copy_source ELSE notes.copy_source END,
         customer_facing = excluded.customer_facing,
         author = excluded.author,
         merged_at = excluded.merged_at,
         url = excluded.url
       RETURNING note_technical`
    )
    .bind(
      newId(),
      n.releaseId,
      n.app,
      n.prNumber,
      n.noteTechnical,
      n.noteCustomer ?? null,
      n.copySource,
      n.customerFacing ? 1 : 0,
      n.author ?? null,
      n.mergedAt ?? null,
      n.url ?? null
    )
    .first<{ note_technical: string | null }>()
  // The DO UPDATE has no WHERE, so RETURNING always yields a row.
  return { noteTechnical: row?.note_technical ?? null }
}

// ---------------------------------------------------------------------------
// entities — GitHub issue/PR cache, idempotent on (repo, kind, number).
// ---------------------------------------------------------------------------
export interface UpsertEntity {
  repo: string
  kind: 'issue' | 'pr'
  number: number
  title: string | null
  state: string | null
  author: string | null
  labels: string[]
  closes: number[]
  updatedAt: number | null
  url: string | null
  /** Milestone title, or null. Plain overwrite — a removed milestone clears. */
  milestone?: string | null
  /** Curated `## Release Note` text extracted from the body, or null. */
  releaseNote?: string | null
  /** Changed file paths for a PR (for path-scoped attribution), or null. */
  files?: string[] | null
  /** GitHub issue type name (issues only). Plain overwrite — a removed type clears. */
  issueType?: string | null
  /** Conversation comment count; omitted/null keeps the stored baseline. */
  commentsCount?: number | null
  /** Set ONLY when meaningful activity was detected (re-surface); else leave unset. */
  lastMeaningfulActivityAt?: number | null
}

export async function upsertEntity(
  db: D1Database,
  e: UpsertEntity
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entities
         (id, repo, kind, number, title, state, author, labels_json,
          updated_at, last_meaningful_activity_at, closes_json, url, milestone, release_note, files_json,
          issue_type, comments_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, kind, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         author = excluded.author,
         labels_json = excluded.labels_json,
         updated_at = excluded.updated_at,
         closes_json = excluded.closes_json,
         url = excluded.url,
         -- Plain overwrite: a milestone/type removed on GitHub must clear here.
         -- Each row has exactly one writer (PR rows: syncEntities; issue rows:
         -- syncIssues), so there is nothing to protect against.
         milestone = excluded.milestone,
         issue_type = excluded.issue_type,
         release_note = excluded.release_note,
         files_json = excluded.files_json,
         -- A source that omits the count never wipes the activity baseline.
         comments_count = COALESCE(excluded.comments_count, entities.comments_count),
         -- Advances ONLY on meaningful activity (bound separately; NULL = keep).
         last_meaningful_activity_at = COALESCE(?, entities.last_meaningful_activity_at)`
    )
    .bind(
      newId(),
      e.repo,
      e.kind,
      e.number,
      e.title,
      e.state,
      e.author,
      JSON.stringify(e.labels),
      e.updatedAt,
      e.lastMeaningfulActivityAt ?? e.updatedAt,
      JSON.stringify(e.closes),
      e.url,
      e.milestone ?? null,
      e.releaseNote ?? null,
      e.files != null ? JSON.stringify(e.files) : null,
      e.issueType ?? null,
      e.commentsCount ?? null,
      e.lastMeaningfulActivityAt ?? null
    )
    .run()
}

// ---------------------------------------------------------------------------
// persona_summaries — per-(release, pr, role) AI or fallback summary rows.
// Never-downgrade upsert: fallback→ai is allowed; ai→fallback is blocked.
// Same-hash re-scan is a no-op (returns false / meta.changes === 0).
// ---------------------------------------------------------------------------
import { stripPrSuffix, type SummaryRole, type SummaryResult } from '../ai/persona-summaries'

const SUMMARY_ROLES: SummaryRole[] = ['developer', 'cx']
function assertRole(role: string): asserts role is SummaryRole {
  if (!SUMMARY_ROLES.includes(role as SummaryRole)) throw new Error(`invalid summary role: ${role}`)
}

const UPSERT_SUMMARY_SQL = `
INSERT INTO persona_summaries
  (id, release_id, pr_number, role, headline, body, source, input_hash, cost_cents, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (release_id, pr_number, role) DO UPDATE SET
  headline   = excluded.headline,
  body       = excluded.body,
  source     = excluded.source,
  input_hash = excluded.input_hash,
  cost_cents = excluded.cost_cents,
  updated_at = excluded.updated_at
WHERE (persona_summaries.source = 'fallback' AND excluded.input_hash != persona_summaries.input_hash)
   OR (excluded.source = 'ai'               AND excluded.input_hash != persona_summaries.input_hash)`

async function upsertSummaryRow(
  db: D1Database,
  a: { releaseId: string; prNumber: number; role: string; headline: string; body: string | null; source: 'ai' | 'fallback'; inputHash: string; costCents: number; now?: number },
): Promise<boolean> {
  assertRole(a.role)
  if (a.source !== 'ai' && a.source !== 'fallback') throw new Error(`invalid summary source: ${a.source}`)
  const t = a.now ?? nowSeconds()
  const r = await db.prepare(UPSERT_SUMMARY_SQL)
    .bind(newId(), a.releaseId, a.prNumber, a.role, a.headline, a.body, a.source, a.inputHash, a.costCents, t, t)
    .run()
  return (r.meta?.changes ?? 0) > 0
}

export function upsertSummary(
  db: D1Database,
  a: { releaseId: string; prNumber: number; role: SummaryRole; result: SummaryResult; inputHash: string; now?: number },
): Promise<boolean> {
  return upsertSummaryRow(db, {
    releaseId: a.releaseId, prNumber: a.prNumber, role: a.role,
    headline: a.result.headline, body: a.result.body, source: 'ai',
    inputHash: a.inputHash, costCents: a.result.costCents, now: a.now,
  })
}

export function writeSummaryFallback(
  db: D1Database,
  a: { releaseId: string; prNumber: number; role: SummaryRole; prTitle: string; inputHash: string; now?: number },
): Promise<boolean> {
  return upsertSummaryRow(db, {
    releaseId: a.releaseId, prNumber: a.prNumber, role: a.role,
    headline: stripPrSuffix(a.prTitle), body: null, source: 'fallback',
    inputHash: a.inputHash, costCents: 0, now: a.now,
  })
}

export async function missingRoles(
  db: D1Database,
  a: { releaseId: string; prNumber: number; customerFacing: boolean },
): Promise<SummaryRole[]> {
  const rows = await db.prepare('SELECT role, source, input_hash FROM persona_summaries WHERE release_id = ? AND pr_number = ?')
    .bind(a.releaseId, a.prNumber).all<{ role: string; source: string; input_hash: string }>()
  const have = new Map(rows.results.map((r) => [r.role, r]))
  const needed: SummaryRole[] = a.customerFacing ? ['developer', 'cx'] : ['developer']
  return needed.filter((role) => {
    const row = have.get(role)
    return !row || row.input_hash === ''
  })
}

/** Look up a cached PR by number: its curated note + linked (closed) issues. */
export interface CachedPr {
  number: number
  release_note: string | null
  closes_json: string | null
  labels_json: string | null
  author: string | null
  url: string | null
  files_json: string | null
  milestone: string | null
}
const CACHED_PR_COLS =
  'number, release_note, closes_json, labels_json, author, url, files_json, milestone'

// D1 caps bound params at 100 per query; keep IN-lists well under it.
const IN_CHUNK = 90
function chunked(numbers: number[]): number[][] {
  const uniq = [...new Set(numbers)]
  const out: number[][] = []
  for (let i = 0; i < uniq.length; i += IN_CHUNK) out.push(uniq.slice(i, i + IN_CHUNK))
  return out
}

/** Cached PRs by number — one query per <=90 numbers. Missing PRs are absent. */
export async function getCachedPrs(
  db: D1Database,
  repo: string,
  numbers: number[]
): Promise<Map<number, CachedPr>> {
  const out = new Map<number, CachedPr>()
  for (const part of chunked(numbers)) {
    const { results } = await db
      .prepare(
        `SELECT ${CACHED_PR_COLS}
           FROM entities WHERE repo = ? AND kind = 'pr' AND number IN (${placeholdersFor(part)})`
      )
      .bind(repo, ...part)
      .all<CachedPr>()
    for (const r of results ?? []) out.set(r.number, r)
  }
  return out
}

/** The issue fields attribution needs (labels/type for customer_facing, milestone for follows). */
export interface CachedIssue {
  number: number
  labels_json: string | null
  issue_type: string | null
  milestone: string | null
}

export async function getIssuesByNumbers(
  db: D1Database,
  repo: string,
  numbers: number[]
): Promise<Map<number, CachedIssue>> {
  const out = new Map<number, CachedIssue>()
  for (const part of chunked(numbers)) {
    const { results } = await db
      .prepare(
        `SELECT number, labels_json, issue_type, milestone
           FROM entities WHERE repo = ? AND kind = 'issue' AND number IN (${placeholdersFor(part)})`
      )
      .bind(repo, ...part)
      .all<CachedIssue>()
    for (const r of results ?? []) out.set(r.number, r)
  }
  return out
}

/** Prior state of a sync page's entities, read BEFORE writing (re-surface detection). */
export interface EntityPrior {
  id: string
  number: number
  state: string | null
  comments_count: number | null
}

export async function getEntitiesPrior(
  db: D1Database,
  repo: string,
  kind: 'issue' | 'pr',
  numbers: number[]
): Promise<Map<number, EntityPrior>> {
  const out = new Map<number, EntityPrior>()
  for (const part of chunked(numbers)) {
    const { results } = await db
      .prepare(
        `SELECT id, number, state, comments_count
           FROM entities WHERE repo = ? AND kind = ? AND number IN (${placeholdersFor(part)})`
      )
      .bind(repo, kind, ...part)
      .all<EntityPrior>()
    for (const r of results ?? []) out.set(r.number, r)
  }
  return out
}

/** Select PRs that still need a dev (or cx when customer_facing=1) summary,
 *  or whose row is retryable (input_hash='' — covers both stale ai and error-fallback).
 *  Oldest-first; NULL merged_at last. */
export async function listPendingSummaries(db: D1Database, limit: number) {
  const r = await db.prepare(`
    SELECT n.release_id, n.pr_number, n.app, n.note_technical, n.customer_facing, n.merged_at
      FROM notes n
      LEFT JOIN persona_summaries ps_dev
        ON ps_dev.release_id = n.release_id AND ps_dev.pr_number = n.pr_number AND ps_dev.role = 'developer'
      LEFT JOIN persona_summaries ps_cx
        ON ps_cx.release_id = n.release_id AND ps_cx.pr_number = n.pr_number AND ps_cx.role = 'cx'
     WHERE ps_dev.id IS NULL
        OR (n.customer_facing = 1 AND ps_cx.id IS NULL)
        OR ps_dev.input_hash = ''
        OR (n.customer_facing = 1 AND ps_cx.input_hash = '')
     ORDER BY COALESCE(n.merged_at, 9999999999) ASC
     LIMIT ?`)
    .bind(limit)
    .all<{ release_id: string; pr_number: number; app: string; note_technical: string | null; customer_facing: number; merged_at: number | null }>()
  return r.results
}

/** Fetch the raw fields needed to build a SummaryInput for one PR. */
export function getSummaryInputRow(db: D1Database, repo: string, prNumber: number) {
  return db.prepare(`
    SELECT
      e_pr.title        AS pr_title,
      e_pr.release_note AS release_note,
      e_pr.labels_json  AS labels_json,
      e_pr.url          AS url,
      CASE WHEN json_valid(e_pr.closes_json) THEN (
        SELECT json_group_array(e_iss.title)
          FROM json_each(e_pr.closes_json) j
          JOIN entities e_iss
            ON e_iss.repo = e_pr.repo AND e_iss.kind = 'issue'
           AND e_iss.number = CAST(j.value AS INTEGER)
      ) ELSE '[]' END   AS issue_titles_json
    FROM entities e_pr
    WHERE e_pr.repo = ? AND e_pr.kind = 'pr' AND e_pr.number = ?`)
    .bind(repo, prNumber)
    .first<{ pr_title: string; release_note: string | null; labels_json: string | null; url: string | null; issue_titles_json: string }>()
}
