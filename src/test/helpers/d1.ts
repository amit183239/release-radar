// Test-only D1 shim backed by better-sqlite3 (:memory:). Implements the subset of
// the D1 prepared-statement API the codebase uses: prepare().bind().all()/first()/run().
// SQL runs for real, so never-downgrade upserts, json_each, and selection queries
// are exercised against actual SQLite — not a hand-rolled fake.
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(HERE, '../../../schema.sql')

class TestStmt {
  private args: unknown[] = []
  constructor(private sqlite: Database.Database, private sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.args) as T[] }
  }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined
    if (row == null) return null
    return (col ? (row[col] as T) : (row as unknown as T))
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const info = this.sqlite.prepare(this.sql).run(...this.args)
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } }
  }
}

export interface TestDb {
  prepare(sql: string): TestStmt
  _raw: Database.Database
}

export function makeTestDb(): TestDb & D1Database {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  const db: TestDb = { prepare: (sql: string) => new TestStmt(sqlite, sql), _raw: sqlite }
  return db as unknown as TestDb & D1Database
}
