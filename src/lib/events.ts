/**
 * Event ledger + feed fan-out (Phase 2). "Shipped" = a followed target's PR
 * landed in a prod tag. On each ship the poll records an idempotent event and
 * fans it out to the feed of every user following the PR, its closed issues,
 * its labels, or the app. Feed items are the in-app notifications.
 *
 * Dedup (review V7): one feed item per (user, event) — enforced by the
 * idx_feed_user_event unique index — so a re-scan never re-alerts.
 */
import { newId, nowSeconds } from './helpers'
import { escapeLike, noteMatchesQuery } from './search'

/** One follow-match candidate for a ship, with its priority (lower = wins). */
export interface ShipMatchRow {
  user_id: string
  matched_type: string
  matched_ref: string
  priority: number
}

/** An active `query` follow, loaded once per tick and matched in JS (Task 11). */
export interface QueryFollow {
  user_id: string
  target_ref: string
}

/** Follow-match priority (lower wins) — one table for fan-out, follow-backfill
 *  winner selection, and read-time ordering (spec §2). */
export const MATCH_PRIORITY = { pr: 1, issue: 2, milestone: 3, label: 4, query: 5, app: 6 } as const
export type MatchType = keyof typeof MATCH_PRIORITY

/** All active query follows (loaded once per tick; matched in JS, never in SQL). */
export async function listQueryFollows(db: D1Database): Promise<QueryFollow[]> {
  const { results } = await db
    .prepare(`SELECT user_id, target_ref FROM follows WHERE archived = 0 AND target_type = 'query'`)
    .bind()
    .all<QueryFollow>()
  return results ?? []
}

/** Reduce match candidates to the single highest-priority (lowest number) match
 *  per user. Pure — the winner is chosen before the feed insert, so idempotent
 *  re-scans recompute the same winner. */
export function pickShipMatch(
  rows: ShipMatchRow[]
): Map<string, { matched_type: string; matched_ref: string }> {
  const best = new Map<string, ShipMatchRow>()
  for (const r of rows) {
    const cur = best.get(r.user_id)
    if (!cur || r.priority < cur.priority) best.set(r.user_id, r)
  }
  const out = new Map<string, { matched_type: string; matched_ref: string }>()
  for (const [u, r] of best) out.set(u, { matched_type: r.matched_type, matched_ref: r.matched_ref })
  return out
}

/** Record a ship event (idempotent on kind+release+pr). Returns the event id. */
export async function recordShipEvent(
  db: D1Database,
  params: { app: string; releaseId: string; prNumber: number; entityId?: string | null }
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO events (id, kind, app, release_id, pr_number, entity_id, created_at)
       VALUES (?, 'shipped', ?, ?, ?, ?, ?)
       ON CONFLICT(kind, release_id, pr_number) DO UPDATE SET app = excluded.app
       RETURNING id`
    )
    .bind(newId(), params.app, params.releaseId, params.prNumber, params.entityId ?? null, nowSeconds())
    .first<{ id: string }>()
  if (!row) throw new Error('recordShipEvent returned no id')
  return row.id
}

/** What an activity (re-surface) event carries — enough to render a card
 *  without joining the entity (issue activity has no pr_number to join on). */
export interface ActivityPayload {
  entity_kind: 'issue' | 'pr'
  number: number
  title: string | null
  url: string | null
  state_from?: string
  state_to?: string
  new_comments?: number
}

/**
 * Record a re-surface activity event, idempotent on `dedupe_key`
 * (`activity:<kind>:<number>:<updatedAtEpoch>`). The legacy
 * UNIQUE(kind, release_id, pr_number) can't dedupe these (release_id is NULL and
 * SQLite NULLs are distinct), hence the partial unique index from migration 0008.
 * `DO UPDATE SET kind = kind` (not DO NOTHING) so RETURNING always yields the id —
 * a retry after a crash still fans out.
 */
export async function recordActivityEvent(
  db: D1Database,
  params: { entityId: string; prNumber: number | null; dedupeKey: string; payload: ActivityPayload }
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO events (id, kind, app, release_id, pr_number, entity_id, payload_json, dedupe_key, created_at)
       VALUES (?, 'activity', NULL, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET kind = kind
       RETURNING id`
    )
    .bind(newId(), params.prNumber, params.entityId, JSON.stringify(params.payload), params.dedupeKey, nowSeconds())
    .first<{ id: string }>()
  if (!row) throw new Error('recordActivityEvent returned no id')
  return row.id
}

/**
 * Fan an activity event out to active followers of EXACTLY that issue/PR
 * (`issue:<n>` / `pr:<n>`). Unread, one row per (user, event). Returns rows created.
 */
export async function fanOutActivity(
  db: D1Database,
  params: { eventId: string; entityKind: 'issue' | 'pr'; number: number }
): Promise<number> {
  const ref = String(params.number)
  const { results } = await db
    .prepare(`SELECT user_id FROM follows WHERE archived = 0 AND target_type = ? AND target_ref = ?`)
    .bind(params.entityKind, ref)
    .all<{ user_id: string }>()
  const now = nowSeconds()
  let created = 0
  for (const { user_id } of results ?? []) {
    const res = await db
      .prepare(
        `INSERT INTO feed (id, user_id, event_id, entity_id, lens, matched_type, matched_ref, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(user_id, event_id) DO NOTHING`
      )
      .bind(newId(), user_id, params.eventId, params.entityKind, ref, now)
      .run()
    created += res.meta.changes ?? 0
  }
  return created
}

/**
 * Fan a ship event out to followers. A user is a follower if they follow the
 * PR, any issue it closes, its milestone(s), any of its labels, a query that
 * matches its stored note, or the app. Feed inserts are idempotent per
 * (user, event). Returns the number of feed items created.
 */
export async function fanOutShip(
  db: D1Database,
  params: {
    eventId: string
    app: string
    prNumber: number
    closesIssues: number[]
    prLabels: string[]
    entityId?: string | null
    /** The STORED note_technical (after the never-downgrade gate). */
    noteTechnical?: string | null
    /** Active query follows, loaded once per tick. */
    queryFollows?: QueryFollow[]
    /** The PR's milestone + its closed issues' milestones (Task 12). */
    milestones?: string[]
  }
): Promise<number> {
  const matches = await followerMatches(db, params)
  if (matches.size === 0) return 0

  const now = nowSeconds()
  let created = 0
  for (const [userId, m] of matches) {
    const res = await db
      .prepare(
        // Winner chosen pre-insert; DO NOTHING keeps it stable on re-scan. A higher-priority follow added AFTER this row exists keeps the original reason (accepted v1 tradeoff).
        `INSERT INTO feed (id, user_id, event_id, entity_id, lens, matched_type, matched_ref, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(user_id, event_id) DO NOTHING`
      )
      .bind(newId(), userId, params.eventId, params.entityId ?? null, m.matched_type, m.matched_ref, now)
      .run()
    created += res.meta.changes ?? 0
  }
  return created
}

/** Resolve every follower of a ship to their single highest-priority match
 *  reason: SQL UNION ALL for exact-ref follows, plus JS-matched query follows
 *  appended before pickShipMatch so one winner rule applies. */
async function followerMatches(
  db: D1Database,
  params: {
    app: string
    prNumber: number
    closesIssues: number[]
    prLabels: string[]
    noteTechnical?: string | null
    queryFollows?: QueryFollow[]
    milestones?: string[]
  }
): Promise<Map<string, { matched_type: string; matched_ref: string }>> {
  const parts: string[] = [
    `SELECT user_id, 'pr' AS matched_type, target_ref AS matched_ref, ? AS priority
       FROM follows WHERE archived = 0 AND target_type = 'pr' AND target_ref = ?`,
    `SELECT user_id, 'app' AS matched_type, target_ref AS matched_ref, ? AS priority
       FROM follows WHERE archived = 0 AND target_type = 'app' AND target_ref = ?`,
  ]
  const binds: unknown[] = [MATCH_PRIORITY.pr, String(params.prNumber), MATCH_PRIORITY.app, params.app]

  if (params.closesIssues.length > 0) {
    const ph = params.closesIssues.map(() => '?').join(',')
    parts.push(
      `SELECT user_id, 'issue' AS matched_type, target_ref AS matched_ref, ? AS priority
         FROM follows WHERE archived = 0 AND target_type = 'issue' AND target_ref IN (${ph})`
    )
    binds.push(MATCH_PRIORITY.issue)
    for (const i of params.closesIssues) binds.push(String(i))
  }
  const milestones = params.milestones ?? []
  if (milestones.length > 0) {
    const ph = milestones.map(() => '?').join(',')
    parts.push(
      `SELECT user_id, 'milestone' AS matched_type, target_ref AS matched_ref, ? AS priority
         FROM follows WHERE archived = 0 AND target_type = 'milestone' AND target_ref IN (${ph})`
    )
    binds.push(MATCH_PRIORITY.milestone)
    for (const m of milestones) binds.push(m)
  }
  if (params.prLabels.length > 0) {
    const ph = params.prLabels.map(() => '?').join(',')
    parts.push(
      `SELECT user_id, 'label' AS matched_type, target_ref AS matched_ref, ? AS priority
         FROM follows WHERE archived = 0 AND target_type = 'label' AND target_ref IN (${ph})`
    )
    binds.push(MATCH_PRIORITY.label)
    for (const l of params.prLabels) binds.push(l)
  }

  const { results } = await db
    .prepare(parts.join('\nUNION ALL\n'))
    .bind(...binds)
    .all<ShipMatchRow>()
  const rows: ShipMatchRow[] = [...(results ?? [])]

  // Query follows: matched in JS against the stored note (no user text in SQL).
  for (const qf of params.queryFollows ?? []) {
    if (noteMatchesQuery(params.noteTechnical ?? null, qf.target_ref)) {
      rows.push({ user_id: qf.user_id, matched_type: 'query', matched_ref: qf.target_ref, priority: MATCH_PRIORITY.query })
    }
  }
  return pickShipMatch(rows)
}

// ---------------------------------------------------------------------------
// Backfill-on-follow: seed the feed with recent history for a just-followed
// target, so its last-week activity shows up immediately (fan-out only ever
// covers FUTURE ships). Backfilled rows are marked READ (historical context,
// no unread-badge spam) and dated at the release's deploy time so they slot
// into the timeline chronologically. Idempotent per (user, event).
// ---------------------------------------------------------------------------
const FOLLOW_BACKFILL_DAYS = 7
const FOLLOW_BACKFILL_CAP = 100

export async function backfillFollowFeed(
  db: D1Database,
  userId: string,
  repo: string,
  targetType: string,
  targetRef: string
): Promise<number> {
  const since = nowSeconds() - FOLLOW_BACKFILL_DAYS * 86_400
  let where: string
  const binds: unknown[] = [since]
  if (targetType === 'app') {
    where = 'e.app = ?'
    binds.push(targetRef)
  } else if (targetType === 'pr') {
    where = 'e.pr_number = CAST(? AS INTEGER)'
    binds.push(targetRef)
  } else if (targetType === 'label') {
    where = `EXISTS (SELECT 1 FROM entities ent, json_each(ent.labels_json) je
                      WHERE ent.repo = ? AND ent.kind = 'pr' AND ent.number = e.pr_number
                        AND je.value = ?)`
    binds.push(repo, targetRef)
  } else if (targetType === 'issue') {
    where = `EXISTS (SELECT 1 FROM entities ent, json_each(ent.closes_json) je
                      WHERE ent.repo = ? AND ent.kind = 'pr' AND ent.number = e.pr_number
                        AND je.value = CAST(? AS INTEGER))`
    binds.push(repo, targetRef)
  } else if (targetType === 'query') {
    // Same escaped LIKE as /api/search, over the stored note.
    where = `EXISTS (SELECT 1 FROM notes nq
                      WHERE nq.release_id = e.release_id AND nq.pr_number = e.pr_number
                        AND nq.note_technical LIKE ? ESCAPE '\\')`
    binds.push(`%${escapeLike(targetRef.trim())}%`)
  } else if (targetType === 'milestone') {
    // PR milestone OR any closed issue's milestone (exact string).
    where = `EXISTS (SELECT 1 FROM entities ent
                      WHERE ent.repo = ? AND ent.kind = 'pr' AND ent.number = e.pr_number
                        AND (ent.milestone = ?
                             OR EXISTS (SELECT 1 FROM json_each(ent.closes_json) je
                                          JOIN entities iss
                                            ON iss.repo = ent.repo AND iss.kind = 'issue'
                                           AND iss.number = CAST(je.value AS INTEGER)
                                         WHERE iss.milestone = ?)))`
    binds.push(repo, targetRef, targetRef)
  } else {
    return 0
  }

  const { results } = await db
    .prepare(
      // e.kind = 'shipped' explicitly: activity events carry pr_number too and
      // must never be backfilled on follow (spec §2c).
      `SELECT e.id AS event_id, r.deployed_at AS deployed_at
         FROM events e
         JOIN releases r ON r.id = e.release_id
        WHERE r.deployed_at >= ? AND e.kind = 'shipped' AND ${where}
        ORDER BY r.deployed_at DESC
        LIMIT ${FOLLOW_BACKFILL_CAP}`
    )
    .bind(...binds)
    .all<{ event_id: string; deployed_at: number }>()
  const rows = results ?? []

  let created = 0
  for (const row of rows) {
    const res = await db
      .prepare(
        `INSERT INTO feed (id, user_id, event_id, entity_id, lens, matched_type, matched_ref, read_at, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(user_id, event_id) DO NOTHING`
      )
      .bind(newId(), userId, row.event_id, targetType, targetRef, row.deployed_at, row.deployed_at)
      .run()
    created += res.meta.changes ?? 0
  }
  return created
}

// ---------------------------------------------------------------------------
// Feed read surface (in-app notifications).
// ---------------------------------------------------------------------------
/** One of the user's follows that a feed item satisfies, with the follow's opaque
 *  CRM refs (only ever the VIEWER's own follow rows — never another user's). */
export interface FeedMatch {
  type: string
  ref: string
  customer_ref?: string | null
  ticket_ref?: string | null
}

interface FollowRefs {
  customer_ref: string | null
  ticket_ref: string | null
}

export interface FeedItem {
  id: string
  read_at: number | null
  created_at: number
  kind: string
  app: string | null
  pr_number: number | null
  release_id: string | null
  tag: string | null
  note_technical: string | null
  url: string | null
  matched_type: string | null
  matched_ref: string | null
  /** ALL of the user's follows this item satisfies (priority
   *  pr>issue>milestone>label>query>app), computed at read time against current
   *  follows for ship rows. Activity rows use only the stored match (no read-time
   *  recompute). matches[0] is the primary. */
  matches: FeedMatch[]
  /** Parsed `events.payload_json` for kind='activity' rows; null for ship rows. */
  payload: ActivityPayload | null
  /** Role-shaped persona summary, merged in the feed route after listFeed returns. */
  summary?: { headline: string; body: string | null; source: 'ai' | 'fallback'; role: string } | null
}

interface FeedRawRow extends Omit<FeedItem, 'payload'> {
  payload_json: string | null
  labels_json: string | null
  closes_json: string | null
  /** The shipped PR's own milestone (read-time milestone matching). */
  pr_milestone: string | null
  /** JSON array of the closed issues' milestones. */
  issue_milestones_json: string | null
}

function jsonArr<T>(s: string | null): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

/** Every current follow the ship satisfies (via its PR, closed issues, milestone,
 *  labels, a matching query, or app), ordered by MATCH_PRIORITY
 *  (pr>issue>milestone>label>query>app). Used for ship rows only; activity rows
 *  keep their stored match. */
function matchesFor(row: FeedRawRow, followed: Map<string, FollowRefs>): FeedMatch[] {
  const out: Array<FeedMatch & { p: number }> = []
  const add = (type: MatchType, ref: string) => {
    const refs = followed.get(`${type}:${ref}`)
    if (refs) out.push({ type, ref, p: MATCH_PRIORITY[type], customer_ref: refs.customer_ref, ticket_ref: refs.ticket_ref })
  }
  if (row.pr_number != null) add('pr', String(row.pr_number))
  for (const iss of jsonArr<number>(row.closes_json)) add('issue', String(iss))
  const milestones = new Set<string>()
  if (row.pr_milestone) milestones.add(row.pr_milestone)
  for (const m of jsonArr<string | null>(row.issue_milestones_json)) if (m) milestones.add(m)
  for (const m of milestones) add('milestone', m)
  for (const lab of jsonArr<string>(row.labels_json)) add('label', String(lab))
  for (const key of followed.keys()) {
    if (!key.startsWith('query:')) continue
    const q = key.slice('query:'.length)
    if (noteMatchesQuery(row.note_technical, q)) add('query', q)
  }
  if (row.app) add('app', row.app)
  out.sort((a, b) => a.p - b.p)
  return out.map(({ p: _p, ...m }) => m)
}

export async function listFeed(
  db: D1Database,
  userId: string,
  repo: string,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Promise<FeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const unread = opts.unreadOnly ? 'AND f.read_at IS NULL' : ''
  // Anonymous `?` only (bind order = textual order: correlated subquery repo, JOIN repo, userId, limit) — the
  // makeTestDb shim binds positionally and rejects numbered `?N` params.
  const { results } = await db
    .prepare(
      `SELECT f.id, f.read_at, f.created_at, f.matched_type, f.matched_ref,
              e.kind, e.payload_json, e.app, e.pr_number, e.release_id,
              r.tag, n.note_technical, n.url,
              ent.labels_json, ent.closes_json, ent.milestone AS pr_milestone,
              (SELECT json_group_array(iss.milestone)
                 FROM json_each(ent.closes_json) je
                 JOIN entities iss
                   ON iss.repo = ? AND iss.kind = 'issue'
                  AND iss.number = CAST(je.value AS INTEGER)
                WHERE iss.milestone IS NOT NULL) AS issue_milestones_json
         FROM feed f
         JOIN events e ON e.id = f.event_id
         LEFT JOIN releases r ON r.id = e.release_id
         LEFT JOIN notes n ON n.release_id = e.release_id AND n.pr_number = e.pr_number
         LEFT JOIN entities ent ON ent.repo = ? AND ent.kind = 'pr' AND ent.number = e.pr_number
        WHERE f.user_id = ? ${unread}
        ORDER BY f.created_at DESC
        LIMIT ?`
    )
    .bind(repo, repo, userId, limit)
    .all<FeedRawRow>()
  const rows = results ?? []

  // Read-time match set from CURRENT follows (fresh, unlike the stored fan-out
  // winner), carrying the viewer's own CRM refs. Scoped to userId.
  const fq = await db
    .prepare(
      'SELECT target_type, target_ref, customer_ref, ticket_ref FROM follows WHERE user_id = ? AND archived = 0'
    )
    .bind(userId)
    .all<{ target_type: string; target_ref: string; customer_ref: string | null; ticket_ref: string | null }>()
  const followed = new Map<string, FollowRefs>(
    (fq.results ?? []).map((f) => [
      `${f.target_type}:${f.target_ref}`,
      { customer_ref: f.customer_ref, ticket_ref: f.ticket_ref },
    ])
  )

  return rows.map((row): FeedItem => {
    const {
      labels_json: _lj,
      closes_json: _cj,
      pr_milestone: _pm,
      issue_milestones_json: _im,
      payload_json,
      ...base
    } = row
    const payload = parsePayload(payload_json)

    // Activity rows were fanned out ONLY to exact issue:/pr: followers — report
    // exactly that stored match, never a re-derived label/issue match.
    if (row.kind === 'activity') {
      const refs = followed.get(`${row.matched_type}:${row.matched_ref}`)
      return {
        ...base,
        payload,
        matches: row.matched_type
          ? [
              {
                type: row.matched_type,
                ref: row.matched_ref ?? '',
                customer_ref: refs?.customer_ref ?? null,
                ticket_ref: refs?.ticket_ref ?? null,
              },
            ]
          : [],
      }
    }

    const matches = matchesFor(row, followed)
    const primary = matches[0]
    return {
      ...base,
      payload,
      matched_type: primary?.type ?? row.matched_type,
      matched_ref: primary?.ref ?? row.matched_ref,
      matches:
        matches.length > 0
          ? matches
          : row.matched_type
            ? [{ type: row.matched_type, ref: row.matched_ref ?? '' }]
            : [],
    }
  })
}

function parsePayload(s: string | null): ActivityPayload | null {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ActivityPayload) : null
  } catch {
    return null
  }
}

export async function unreadCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM feed WHERE user_id = ? AND read_at IS NULL')
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function markRead(
  db: D1Database,
  userId: string,
  feedId: string
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE feed SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
    .bind(nowSeconds(), feedId, userId)
    .run()
  return (res.meta.changes ?? 0) > 0
}

export async function markAllRead(db: D1Database, userId: string): Promise<number> {
  const res = await db
    .prepare('UPDATE feed SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .bind(nowSeconds(), userId)
    .run()
  return res.meta.changes ?? 0
}

// ---------------------------------------------------------------------------
// Persona digest — role-shaped AI summary feed (NOT follow-gated).
// ---------------------------------------------------------------------------

export interface DigestItem {
  release_id: string
  pr_number: number
  app: string
  tag: string
  deployed_at: number
  headline: string
  body: string | null
  source: 'ai'
  note_technical: string | null
  url: string | null
}

/**
 * Role-shaped digest of ALL ai persona summaries for `role`, across every app,
 * newest release first. NOT follow-gated. `role` is 'developer' | 'cx'.
 */
export async function listPersonaDigest(
  db: D1Database,
  role: 'developer' | 'cx',
  limit = 100,
): Promise<DigestItem[]> {
  const r = await db
    .prepare(
      `SELECT ps.release_id, ps.pr_number, ps.headline, ps.body, ps.source,
              rel.app, rel.tag, rel.deployed_at,
              n.note_technical, n.url
         FROM persona_summaries ps
         JOIN releases rel ON rel.id = ps.release_id
         LEFT JOIN notes n ON n.release_id = ps.release_id AND n.pr_number = ps.pr_number
        WHERE ps.role = ? AND ps.source = 'ai'
        ORDER BY rel.deployed_at DESC, ps.pr_number DESC
        LIMIT ?`,
    )
    .bind(role, limit)
    .all<DigestItem>()
  return r.results
}
