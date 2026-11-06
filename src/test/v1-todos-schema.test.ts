import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'

const ACTIVITY_INSERT = `INSERT INTO events (id, kind, app, release_id, pr_number, entity_id, payload_json, dedupe_key, created_at)
     VALUES (?, 'activity', NULL, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET kind = kind
     RETURNING id`

describe('migration 0008 (v1 TODOs)', () => {
  it('adds entities.comments_count', async () => {
    const db = makeTestDb()
    const cols = await db.prepare("PRAGMA table_info('entities')").all<{ name: string }>()
    expect(cols.results.map((c) => c.name)).toContain('comments_count')
  })

  it('adds events.dedupe_key', async () => {
    const db = makeTestDb()
    const cols = await db.prepare("PRAGMA table_info('events')").all<{ name: string }>()
    expect(cols.results.map((c) => c.name)).toContain('dedupe_key')
  })

  it('dedupes activity events on dedupe_key and RETURNING yields the existing id', async () => {
    const db = makeTestDb()
    const a = await db
      .prepare(ACTIVITY_INSERT)
      .bind('ev1', null, 'ent1', '{}', 'activity:issue:92:100', 100)
      .first<{ id: string }>()
    const b = await db
      .prepare(ACTIVITY_INSERT)
      .bind('ev2', null, 'ent1', '{}', 'activity:issue:92:100', 100)
      .first<{ id: string }>()
    expect(a!.id).toBe('ev1')
    expect(b!.id).toBe('ev1')
    const n = await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('leaves NULL dedupe_key rows (shipped events) unconstrained', async () => {
    const db = makeTestDb()
    const ins = `INSERT INTO events (id, kind, app, release_id, pr_number, created_at) VALUES (?, 'shipped', 'checkout', ?, ?, ?)`
    await db.prepare(ins).bind('s1', 'rel-1', 10, 1).run()
    await db.prepare(ins).bind('s2', 'rel-2', 10, 1).run()
    const n = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE dedupe_key IS NULL').first<{ n: number }>()
    expect(n!.n).toBe(2)
  })

  it('idx_events_dedupe is a partial index', async () => {
    const db = makeTestDb()
    const row = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .bind('idx_events_dedupe')
      .first<{ sql: string }>()
    expect(row!.sql).toContain('WHERE dedupe_key IS NOT NULL')
  })
})
