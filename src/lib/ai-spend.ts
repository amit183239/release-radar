/**
 * Monthly AI spend cap (§3 cost ceilings, review V9). The off-tick generation
 * job checks the cap before each call and records cost after, so a runaway
 * provider can't spend unboundedly. Keyed by UTC `YYYY-MM`.
 */
import { nowSeconds } from './helpers'

/** Current UTC month key, e.g. "2026-08". Pure of Date.now via nowSeconds. */
export function monthKey(): string {
  return new Date(nowSeconds() * 1000).toISOString().slice(0, 7)
}

export async function getSpendCents(db: D1Database, month: string): Promise<number> {
  const row = await db
    .prepare('SELECT cost_cents FROM ai_spend WHERE month = ?')
    .bind(month)
    .first<{ cost_cents: number }>()
  return row?.cost_cents ?? 0
}

/** Record a completed AI call's cost against the month, atomically. */
export async function addSpend(
  db: D1Database,
  month: string,
  cents: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_spend (month, calls, cost_cents, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(month) DO UPDATE SET
         calls = ai_spend.calls + 1,
         cost_cents = ai_spend.cost_cents + excluded.cost_cents,
         updated_at = excluded.updated_at`
    )
    .bind(month, cents, nowSeconds())
    .run()
}

/**
 * True when this month's spend has reached the cap. capCents === 0 means the
 * cap is disabled ONLY if AI itself is off; here a 0 cap means "no budget", so
 * the cap is considered reached (fail-closed on spend).
 */
export async function capReached(
  db: D1Database,
  capCents: number
): Promise<boolean> {
  if (capCents <= 0) return true
  return (await getSpendCents(db, monthKey())) >= capCents
}
