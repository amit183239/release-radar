import { describe, it, expect } from 'vitest'
import { makeTestDb } from './d1'

describe('makeTestDb', () => {
  it('loads schema.sql and round-trips a row via the D1 API surface', async () => {
    const db = makeTestDb()
    await db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
            .bind('u1', 'a@b.io', 100).run()
    const row = await db.prepare('SELECT email FROM users WHERE id = ?').bind('u1').first<{ email: string }>()
    expect(row?.email).toBe('a@b.io')
    const scalar = await db.prepare('SELECT email FROM users WHERE id = ?').bind('u1').first<string>('email')
    expect(scalar).toBe('a@b.io')
    const list = await db.prepare('SELECT id FROM users').all<{ id: string }>()
    expect(list.results.map((r) => r.id)).toEqual(['u1'])
    const upd = await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind('c@d.io', 'u1').run()
    expect(upd.meta.changes).toBe(1)
  })
})
