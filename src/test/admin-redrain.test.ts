import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { countAiSummaries, staleAllAiSummaries } from '../routes/admin'
import { upsertSummary, writeSummaryFallback } from '../lib/queries'

describe('admin redrain SQL', () => {
  it('counts only ai rows and stales them (fallback rows untouched)', async () => {
    const db = makeTestDb()
    await upsertSummary(db, { releaseId: 'r1', prNumber: 1, role: 'developer', result: { headline: 'H', body: null, costCents: 1 }, inputHash: 'h1', now: 1 })
    await writeSummaryFallback(db, { releaseId: 'r2', prNumber: 2, role: 'cx', prTitle: 'x (#2)', inputHash: 'h2', now: 1 })
    expect(await countAiSummaries(db)).toBe(1)
    expect(await staleAllAiSummaries(db)).toBe(1)
    const stale = await db.prepare("SELECT input_hash FROM persona_summaries WHERE source='ai'").first<{ input_hash: string }>()
    expect(stale?.input_hash).toBe('')
    const fb = await db.prepare("SELECT input_hash FROM persona_summaries WHERE source='fallback'").first<{ input_hash: string }>()
    expect(fb?.input_hash).toBe('h2') // untouched
  })
})
