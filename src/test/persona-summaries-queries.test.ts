import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertSummary, writeSummaryFallback, missingRoles } from '../lib/queries'

const res = (h = 'H', b: string | null = 'B') => ({ headline: h, body: b, costCents: 2 })

describe('upsertSummary never-downgrade', () => {
  it('ai survives a later fallback; fallback+changed-hash upgrades to ai; same-hash is a no-op', async () => {
    const db = makeTestDb()
    expect(await upsertSummary(db, { releaseId: 'r1', prNumber: 1, role: 'developer', result: res(), inputHash: 'h1', now: 10 })).toBe(true)
    // ai + same hash again → no-op
    expect(await upsertSummary(db, { releaseId: 'r1', prNumber: 1, role: 'developer', result: res('H2'), inputHash: 'h1', now: 11 })).toBe(false)
    // ai + different hash → replace
    expect(await upsertSummary(db, { releaseId: 'r1', prNumber: 1, role: 'developer', result: res('H3'), inputHash: 'h2', now: 12 })).toBe(true)
    // incoming fallback never downgrades an ai row
    expect(await writeSummaryFallback(db, { releaseId: 'r1', prNumber: 1, role: 'developer', prTitle: 'x (#1)', inputHash: 'h3', now: 13 })).toBe(false)
    const row = await db.prepare("SELECT headline, source FROM persona_summaries WHERE release_id='r1' AND pr_number=1 AND role='developer'").first<{ headline: string; source: string }>()
    expect(row).toEqual({ headline: 'H3', source: 'ai' })
  })

  it('fallback + same hash re-scan is a no-op (no write churn)', async () => {
    const db = makeTestDb()
    await writeSummaryFallback(db, { releaseId: 'r2', prNumber: 2, role: 'cx', prTitle: 'Tiny (#2)', inputHash: 'k1', now: 1 })
    expect(await writeSummaryFallback(db, { releaseId: 'r2', prNumber: 2, role: 'cx', prTitle: 'Tiny (#2)', inputHash: 'k1', now: 2 })).toBe(false)
  })

  it('rejects a bad role before any DB write', async () => {
    const db = makeTestDb()
    await expect(upsertSummary(db, { releaseId: 'r', prNumber: 1, role: 'pm' as any, result: res(), inputHash: 'h', now: 1 })).rejects.toThrow()
    const n = await db.prepare('SELECT COUNT(*) AS c FROM persona_summaries').first<{ c: number }>()
    expect(n?.c).toBe(0)
  })
})

describe('missingRoles', () => {
  it('needs dev always, cx only when customer-facing; excludes present ai rows; re-includes stale (input_hash="")', async () => {
    const db = makeTestDb()
    expect(await missingRoles(db, { releaseId: 'r3', prNumber: 3, customerFacing: true })).toEqual(['developer', 'cx'])
    await upsertSummary(db, { releaseId: 'r3', prNumber: 3, role: 'developer', result: res(), inputHash: 'h', now: 1 })
    expect(await missingRoles(db, { releaseId: 'r3', prNumber: 3, customerFacing: true })).toEqual(['cx'])
    expect(await missingRoles(db, { releaseId: 'r3', prNumber: 3, customerFacing: false })).toEqual([])
    // mark dev stale:
    await db.prepare("UPDATE persona_summaries SET input_hash='' WHERE release_id='r3' AND pr_number=3 AND role='developer'").run()
    expect(await missingRoles(db, { releaseId: 'r3', prNumber: 3, customerFacing: false })).toEqual(['developer'])
  })

  it('fallback row with input_hash="" is re-selected (error-fallback sentinel)', async () => {
    const db = makeTestDb()
    // Write an error-fallback (source=fallback, hash='') for both roles
    await writeSummaryFallback(db, { releaseId: 'r4', prNumber: 4, role: 'developer', prTitle: 'Fix bug (#4)', inputHash: '', now: 1 })
    await writeSummaryFallback(db, { releaseId: 'r4', prNumber: 4, role: 'cx', prTitle: 'Fix bug (#4)', inputHash: '', now: 1 })
    // Both must be re-selected ('' sentinel is retryable regardless of source)
    expect(await missingRoles(db, { releaseId: 'r4', prNumber: 4, customerFacing: true })).toEqual(['developer', 'cx'])
    expect(await missingRoles(db, { releaseId: 'r4', prNumber: 4, customerFacing: false })).toEqual(['developer'])
  })

  it('fallback row with real hash (thin-input) is NOT re-selected', async () => {
    const db = makeTestDb()
    // Write a thin-input fallback with a real hash (permanent until input changes)
    await writeSummaryFallback(db, { releaseId: 'r5', prNumber: 5, role: 'developer', prTitle: 'Tiny (#5)', inputHash: 'real-hash-abc', now: 1 })
    // Must not appear in missingRoles — it has a real hash so it is satisfied
    expect(await missingRoles(db, { releaseId: 'r5', prNumber: 5, customerFacing: false })).toEqual([])
  })

  it('error-fallback (fallback, hash="") upgrades to ai when provider recovers (never-downgrade trace)', async () => {
    const db = makeTestDb()
    // Simulate error-fallback written by the drainer
    await writeSummaryFallback(db, { releaseId: 'r6', prNumber: 6, role: 'developer', prTitle: 'Ship it (#6)', inputHash: '', now: 1 })
    // Provider recovers — upsert with real hash and source=ai
    const upgraded = await upsertSummary(db, { releaseId: 'r6', prNumber: 6, role: 'developer', result: res('Recovered'), inputHash: 'real-hash', now: 2 })
    expect(upgraded).toBe(true)
    const row = await db.prepare("SELECT source, input_hash, headline FROM persona_summaries WHERE release_id='r6' AND pr_number=6 AND role='developer'")
      .first<{ source: string; input_hash: string; headline: string }>()
    expect(row?.source).toBe('ai')
    expect(row?.input_hash).toBe('real-hash')
    expect(row?.headline).toBe('Recovered')
  })
})
