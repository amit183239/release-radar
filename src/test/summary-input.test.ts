import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { buildSummaryInput } from '../lib/summary-input'

async function seed(db: any) {
  const insEnt = (kind: string, number: number, title: string, extra: Partial<{ labels_json: string; closes_json: string; release_note: string; url: string }> = {}) =>
    db.prepare('INSERT INTO entities (id, repo, kind, number, title, state, labels_json, closes_json, release_note, url, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(`${kind}-${number}`, 'o/r', kind, number, title, 'MERGED', extra.labels_json ?? '[]', extra.closes_json ?? '[]', extra.release_note ?? null, extra.url ?? null, 1).run()
  await insEnt('issue', 91, 'Advertisers cannot bulk-invite billings')
  await insEnt('issue', 92, 'Payout webhook retries missing')
  await insEnt('pr', 42, 'Add a sharing toolkit for billing advertisers (#42)', {
    labels_json: '["Feature","Billing"]', closes_json: '[91,92]', release_note: 'Advertisers can now invite billings in bulk.', url: 'u42',
  })
}

describe('buildSummaryInput', () => {
  it('assembles release_note, lower-cased labels, and linked-issue titles', async () => {
    const db = makeTestDb(); await seed(db)
    const input = await buildSummaryInput(db, { repo: 'o/r', app: 'billing', prNumber: 42, role: 'developer', noteTechnical: 'Add a sharing toolkit for billing advertisers' })
    expect(input.releaseNote).toContain('invite billings')
    expect(input.labels).toEqual(['feature', 'billing'])
    expect(input.linkedIssueTitles.sort()).toEqual(['Advertisers cannot bulk-invite billings', 'Payout webhook retries missing'].sort())
    // noteTechnical equals the suffix-stripped PR title → dropped to null
    expect(input.noteTechnical).toBeNull()
  })

  it('tolerates malformed closes_json (json_valid guard) → no issue titles', async () => {
    const db = makeTestDb()
    await db.prepare('INSERT INTO entities (id, repo, kind, number, title, state, labels_json, closes_json, release_note, url, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind('pr-7', 'o/r', 'pr', 7, 'Fix thing (#7)', 'MERGED', '[]', 'not-json', null, null, 1).run()
    const input = await buildSummaryInput(db, { repo: 'o/r', app: 'x', prNumber: 7, role: 'developer', noteTechnical: 'Different technical note' })
    expect(input.linkedIssueTitles).toEqual([])
    expect(input.noteTechnical).toBe('Different technical note')
  })
})
