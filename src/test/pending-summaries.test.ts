import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { listPendingSummaries, upsertSummary, writeSummaryFallback } from '../lib/queries'

async function note(db: any, releaseId: string, pr: number, cf: number, mergedAt: number | null) {
  await db.prepare('INSERT INTO notes (id, release_id, app, pr_number, note_technical, customer_facing, merged_at) VALUES (?,?,?,?,?,?,?)')
    .bind(`n-${pr}`, releaseId, 'billing', pr, `note ${pr}`, cf, mergedAt).run()
}
const ai = (db: any, releaseId: string, pr: number, role: 'developer' | 'cx', hash = 'h') =>
  upsertSummary(db, { releaseId, prNumber: pr, role, result: { headline: 'H', body: null, costCents: 1 }, inputHash: hash, now: 1 })

describe('listPendingSummaries', () => {
  it('selects missing-dev and dev-done/cx-missing; skips fully-done; ignores cx for non-CF', async () => {
    const db = makeTestDb()
    await note(db, 'r1', 1, 1, 100)  // CF, nothing yet → dev+cx pending
    await note(db, 'r2', 2, 1, 200); await ai(db, 'r2', 2, 'developer')  // dev done, cx missing → pending
    await note(db, 'r3', 3, 1, 300); await ai(db, 'r3', 3, 'developer'); await ai(db, 'r3', 3, 'cx')  // done → not pending
    await note(db, 'r4', 4, 0, 400); await ai(db, 'r4', 4, 'developer')  // non-CF, dev done → not pending (cx not needed)
    const rows = await listPendingSummaries(db, 10)
    expect(rows.map((r) => r.pr_number).sort()).toEqual([1, 2])
  })

  it('orders oldest-first with NULL merged_at last', async () => {
    const db = makeTestDb()
    await note(db, 'a', 10, 0, 500)
    await note(db, 'b', 11, 0, null)
    await note(db, 'c', 12, 0, 100)
    const rows = await listPendingSummaries(db, 10)
    expect(rows.map((r) => r.pr_number)).toEqual([12, 10, 11])
  })

  it('re-selects a stale ai row (input_hash="")', async () => {
    const db = makeTestDb()
    await note(db, 's', 20, 0, 100); await ai(db, 's', 20, 'developer')
    expect((await listPendingSummaries(db, 10)).map((r) => r.pr_number)).toEqual([])
    await db.prepare("UPDATE persona_summaries SET input_hash='' WHERE role='developer'").run()
    expect((await listPendingSummaries(db, 10)).map((r) => r.pr_number)).toEqual([20])
  })

  it('re-selects a fallback row with input_hash="" (error-fallback sentinel)', async () => {
    const db = makeTestDb()
    await note(db, 'ef', 30, 1, 100)
    // Write error-fallback for both roles (source=fallback, hash='')
    await writeSummaryFallback(db, { releaseId: 'ef', prNumber: 30, role: 'developer', prTitle: 'Ship it (#30)', inputHash: '', now: 1 })
    await writeSummaryFallback(db, { releaseId: 'ef', prNumber: 30, role: 'cx', prTitle: 'Ship it (#30)', inputHash: '', now: 1 })
    // Must be re-selected ('' sentinel is retryable regardless of source)
    expect((await listPendingSummaries(db, 10)).map((r) => r.pr_number)).toEqual([30])
  })

  it('does NOT re-select a fallback row with a real hash (thin-input — permanent)', async () => {
    const db = makeTestDb()
    await note(db, 'ti', 40, 1, 100)
    // Write thin-input fallback with a real hash for both roles
    await writeSummaryFallback(db, { releaseId: 'ti', prNumber: 40, role: 'developer', prTitle: 'Fix typo (#40)', inputHash: 'real-hash', now: 1 })
    await writeSummaryFallback(db, { releaseId: 'ti', prNumber: 40, role: 'cx', prTitle: 'Fix typo (#40)', inputHash: 'real-hash', now: 1 })
    // Must NOT be re-selected — real hash means permanently satisfied until input changes
    expect((await listPendingSummaries(db, 10)).map((r) => r.pr_number)).toEqual([])
  })
})
