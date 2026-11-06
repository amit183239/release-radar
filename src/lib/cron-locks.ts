import { nowSeconds, newId } from './helpers'

/**
 * Distributed cron lock, vendored from the billing app. Guards the poll tick
 * so two overlapping cron invocations can't double-process a tag chain.
 * `lock_token` is required by releaseLock so a slow runner whose TTL elapsed
 * cannot delete the lock now held by a fresh runner.
 */
export interface LockAcquisition {
  acquired: boolean
  /** Token to pass back to releaseLock. Undefined when acquired = false. */
  token?: string
}

export async function acquireLock(
  db: D1Database,
  jobName: string,
  ttlSeconds: number
): Promise<LockAcquisition> {
  const now = nowSeconds()

  // Delete stale locks first (past TTL).
  await db
    .prepare(
      'DELETE FROM cron_locks WHERE job_name = ? AND (locked_at + ttl_seconds) < ?'
    )
    .bind(jobName, now)
    .run()

  const token = newId()
  try {
    await db
      .prepare(
        'INSERT INTO cron_locks (job_name, locked_at, ttl_seconds, lock_token) VALUES (?, ?, ?, ?)'
      )
      .bind(jobName, now, ttlSeconds, token)
      .run()
    return { acquired: true, token }
  } catch (e) {
    // Narrow the catch: ONLY a UNIQUE-constraint violation means another
    // runner holds the lock. Anything else (missing table, transport failure)
    // is a real bug and must surface in cron output.
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE constraint failed') || msg.includes('UNIQUE')) {
      return { acquired: false }
    }
    throw e
  }
}

/**
 * Release a lock only if the token matches the one stored at acquisition. A
 * mismatch means our TTL expired and another runner stole the lock — we must
 * NOT delete their row.
 */
export async function releaseLock(
  db: D1Database,
  jobName: string,
  token: string
): Promise<void> {
  const result = await db
    .prepare('DELETE FROM cron_locks WHERE job_name = ? AND lock_token = ?')
    .bind(jobName, token)
    .run()
  if ((result.meta.changes ?? 0) === 0) {
    console.warn(
      `[releaseLock] no-op for job=${jobName} — TTL likely expired and lock was stolen`
    )
  }
}
