/**
 * The follow primitive (Phase 2, §2). One `follows` row over target types
 * {issue, pr, label, milestone, query, app}. "Subscribe" = follow an app.
 * customer_ref/ticket_ref are opaque CRM links (never routable/customer names).
 */
import { newId, nowSeconds } from './helpers'

export const FOLLOW_TARGET_TYPES = [
  'issue',
  'pr',
  'label',
  'milestone',
  'query',
  'app',
] as const
export type FollowTargetType = (typeof FOLLOW_TARGET_TYPES)[number]

export function isFollowTargetType(v: string): v is FollowTargetType {
  return (FOLLOW_TARGET_TYPES as readonly string[]).includes(v)
}

export interface FollowRow {
  id: string
  user_id: string
  target_type: string
  target_ref: string
  customer_ref: string | null
  ticket_ref: string | null
  archived: number
  muted_at: number | null
  created_at: number
  /** Cached title/state of the followed issue or PR (from the entity cache),
   *  null for app/label/other targets or an issue/PR not yet ingested. */
  entity_title?: string | null
  entity_state?: string | null
}

/** Idempotent on (user_id, target_type, target_ref). Returns the follow id. */
export async function createFollow(
  db: D1Database,
  params: {
    userId: string
    targetType: FollowTargetType
    targetRef: string
    customerRef?: string | null
    ticketRef?: string | null
  }
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO follows
         (id, user_id, target_type, target_ref, customer_ref, ticket_ref, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id, target_type, target_ref) DO UPDATE SET
         -- A re-follow without refs must not wipe refs attached earlier.
         -- To clear refs: unfollow (hard DELETE) + re-follow.
         customer_ref = COALESCE(excluded.customer_ref, follows.customer_ref),
         ticket_ref = COALESCE(excluded.ticket_ref, follows.ticket_ref),
         archived = 0
       RETURNING id`
    )
    .bind(
      newId(),
      params.userId,
      params.targetType,
      params.targetRef,
      params.customerRef ?? null,
      params.ticketRef ?? null,
      nowSeconds()
    )
    .first<{ id: string }>()
  if (!row) throw new Error('createFollow returned no id')
  return row.id
}

/** Delete a follow, scoped to its owner (a user can only unfollow their own). */
export async function deleteFollow(
  db: D1Database,
  userId: string,
  id: string
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM follows WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run()
  return (res.meta.changes ?? 0) > 0
}

export async function listFollows(
  db: D1Database,
  userId: string,
  repo: string
): Promise<FollowRow[]> {
  // Enrich issue/pr follows with their cached title + state so the UI can show
  // "#92 — Consent banner flickers" instead of a bare number. The LEFT JOIN only
  // matches when target_type is 'issue'/'pr' (entities.kind); app/label rows keep
  // null title.
  const { results } = await db
    .prepare(
      `SELECT f.*, e.title AS entity_title, e.state AS entity_state
         FROM follows f
         LEFT JOIN entities e
           ON e.repo = ? AND e.kind = f.target_type
          AND CAST(e.number AS TEXT) = f.target_ref
        WHERE f.user_id = ? AND f.archived = 0
        ORDER BY f.created_at DESC`
    )
    .bind(repo, userId)
    .all<FollowRow>()
  return results ?? []
}
