/**
 * Admin triggers. `/admin/poll` and `/admin/backfill` run when DEBUG=true (local)
 * OR on a POST carrying `Authorization: Bearer <ADMIN_TOKEN>` (prod/sandbox
 * out-of-band trigger — the backfill has no cron). `/admin/ai-summaries` and
 * `/admin/redrain` spend AI budget and stay DEBUG-only. Request headers are never
 * logged.
 *
 * Both jobs are self-guarded by the cron_locks singleton and are idempotent, so
 * hitting these repeatedly is safe. Backfill is capped/resumable per invocation
 * (COMPARE_CAP_PER_RUN); call it until `{ done: true }` to finish a large history.
 */
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { tokenMatches } from '../lib/admin-auth'
import type { Env } from '../env'
import { runPoll } from '../jobs/poll'
import { runBackfill } from '../jobs/backfill'
import { runAiSummaries } from '../jobs/ai-summaries'

const admin = new Hono<{ Bindings: Env }>()

type AdminBindings = { Bindings: Pick<Env, 'DEBUG' | 'ADMIN_TOKEN'> }

/** Fail-closed: DEBUG=true only. */
export const debugOnly: MiddlewareHandler<AdminBindings> = async (c, next) => {
  if (c.env.DEBUG !== 'true') return c.json({ error: 'not available' }, 403)
  await next()
}

/** DEBUG=true, or a POST with a matching ADMIN_TOKEN bearer (fail-closed). */
export const debugOrToken: MiddlewareHandler<AdminBindings> = async (c, next) => {
  if (c.env.DEBUG === 'true') return next()
  if (c.req.method !== 'POST') return c.json({ error: 'not available' }, 403)
  if (!(await tokenMatches(c.req.header('Authorization'), c.env.ADMIN_TOKEN))) {
    return c.json({ error: 'not available' }, 403)
  }
  await next()
}

/** POST|GET (DEBUG) · POST + Bearer token (deployed) /admin/poll — run the steady-state poll tick once, now. */
admin.all('/admin/poll', debugOrToken, async (c) => {
  const result = await runPoll(c.env)
  return c.json({ job: 'poll', result })
})

/**
 * POST|GET (DEBUG) · POST + Bearer token (deployed) /admin/backfill — run one capped backfill invocation. Returns the
 * job result including `done`; re-call while `done === false` to process the
 * rest of a large history window.
 */
admin.all('/admin/backfill', debugOrToken, async (c) => {
  const result = await runBackfill(c.env)
  return c.json({ job: 'backfill', result })
})

/** POST|GET /admin/ai-summaries — run the persona-summary drainer once, now. */
admin.all('/admin/ai-summaries', debugOnly, async (c) => {
  const result = await runAiSummaries(c.env)
  return c.json({ job: 'ai-summaries', result })
})

// ---------------------------------------------------------------------------
// Re-drain helpers — exported for unit tests.
// ---------------------------------------------------------------------------

/** Count ai-sourced persona_summary rows (used for dry-run estimate). */
export async function countAiSummaries(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS c FROM persona_summaries WHERE source='ai'").first<{ c: number }>()
  return r?.c ?? 0
}

/**
 * Mark all ai-sourced persona_summary rows stale by clearing input_hash.
 * The drainer's stale-hash arm (Task 9) will regenerate them on the next tick.
 * Fallback rows are untouched (WHERE source='ai' guard).
 * Returns the number of rows updated (meta.changes).
 */
export async function staleAllAiSummaries(db: D1Database): Promise<number> {
  const r = await db.prepare("UPDATE persona_summaries SET input_hash='' WHERE source='ai'").run()
  return r.meta?.changes ?? 0
}

/**
 * POST /admin/redrain — invalidate all ai persona_summaries so the drainer
 * regenerates them (useful after PERSONA_SUMMARY_VERSION or prompt changes).
 *
 * Query params:
 *   (default / ?dry=1) → dry-run: returns { count } without touching the DB.
 *   ?confirm=1         → live run: clears input_hash on all ai rows, returns { staled }.
 *
 * DEBUG-only (spends AI budget) — never reachable with ADMIN_TOKEN.
 */
admin.all('/admin/redrain', debugOnly, async (c) => {
  const confirm = c.req.query('confirm') === '1'
  const db = c.env.DB
  if (!confirm) {
    const count = await countAiSummaries(db)
    return c.json({ count })
  }
  const staled = await staleAllAiSummaries(db)
  return c.json({ staled })
})

export { admin }
export default admin
