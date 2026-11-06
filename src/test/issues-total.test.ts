import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity } from '../lib/queries'
import { listIssues } from '../routes/issues'

describe('listIssues', () => {
  it('returns the page plus the total count for the repo', async () => {
    const db = makeTestDb()
    for (let n = 1; n <= 5; n++) {
      await upsertEntity(db, {
        repo: 'o/r', kind: 'issue', number: n, title: `Issue ${n}`, state: n <= 2 ? 'OPEN' : 'CLOSED',
        author: null, labels: n === 1 ? ['bug'] : [], closes: [], updatedAt: 1_000 + n, url: `u${n}`,
        milestone: n === 1 ? 'Q4 Checkout' : null,
      })
    }
    // Other repo + a PR must not count.
    await upsertEntity(db, { repo: 'x/y', kind: 'issue', number: 9, title: 'other', state: 'OPEN', author: null, labels: [], closes: [], updatedAt: 1, url: null })
    await upsertEntity(db, { repo: 'o/r', kind: 'pr', number: 10, title: 'pr', state: 'OPEN', author: null, labels: [], closes: [], updatedAt: 1, url: null })

    const page = await listIssues(db, 'o/r', 2, 0)
    expect(page.total).toBe(5)
    expect(page.issues.map((i) => i.number)).toEqual([2, 1]) // open first, newest-updated first
    expect(page.issues[1]).toEqual({ number: 1, title: 'Issue 1', state: 'OPEN', labels: ['bug'], milestone: 'Q4 Checkout', url: 'u1' })

    const next = await listIssues(db, 'o/r', 2, 4)
    expect(next.total).toBe(5)
    expect(next.issues).toHaveLength(1)
  })
})
