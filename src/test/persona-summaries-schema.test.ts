import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'

describe('persona_summaries schema', () => {
  it('exists with the unique constraint and lookup index', async () => {
    const db = makeTestDb()
    const cols = await db.prepare("PRAGMA table_info('persona_summaries')").all<{ name: string }>()
    expect(cols.results.map((c) => c.name).sort()).toEqual(
      ['body', 'cost_cents', 'created_at', 'headline', 'id', 'input_hash', 'pr_number', 'release_id', 'role', 'source', 'updated_at'].sort(),
    )
    const idx = await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='persona_summaries'").all<{ name: string }>()
    expect(idx.results.some((r) => r.name === 'idx_persona_summaries_lookup')).toBe(true)
    // unique(release_id, pr_number, role) enforced:
    const ins = (role: string) => db.prepare(
      'INSERT INTO persona_summaries (id, release_id, pr_number, role, headline, body, source, input_hash, cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(role, 'r1', 1, role, 'h', null, 'ai', 'abc', 0, 1, 1).run()
    await ins('developer')
    await expect(db.prepare(
      'INSERT INTO persona_summaries (id, release_id, pr_number, role, headline, body, source, input_hash, cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('dup', 'r1', 1, 'developer', 'h2', null, 'ai', 'xyz', 0, 2, 2).run()).rejects.toThrow()
  })
})
