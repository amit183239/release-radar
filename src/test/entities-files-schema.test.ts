import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'

describe('entities.files_json column', () => {
  it('exists and accepts a JSON array', async () => {
    const db = makeTestDb()
    const cols = await db.prepare("PRAGMA table_info('entities')").all<{ name: string }>()
    expect(cols.results.map((c) => c.name)).toContain('files_json')
    await db.prepare("INSERT INTO entities (id, repo, kind, number, title, state, updated_at, files_json) VALUES (?,?,?,?,?,?,?,?)")
      .bind('e1', 'o/r', 'pr', 1, 't', 'MERGED', 1, JSON.stringify(['apps/platform/x.ts'])).run()
    const row = await db.prepare("SELECT files_json FROM entities WHERE id='e1'").first<{ files_json: string }>()
    expect(JSON.parse(row!.files_json)).toEqual(['apps/platform/x.ts'])
  })
})
