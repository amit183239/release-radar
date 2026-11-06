import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity } from '../lib/queries'
import { suggestMilestones } from '../routes/suggest'

describe('suggestMilestones', () => {
  it('returns distinct milestones (issues + PRs) for the repo, contains-match, LIKE-escaped', async () => {
    const db = makeTestDb()
    const base = { author: null, labels: [], closes: [], updatedAt: 1, url: null, state: 'OPEN', title: 't' }
    await upsertEntity(db, { ...base, repo: 'o/r', kind: 'issue', number: 1, milestone: 'Q4 Checkout' })
    await upsertEntity(db, { ...base, repo: 'o/r', kind: 'pr', number: 2, milestone: 'Q4 Checkout' })
    await upsertEntity(db, { ...base, repo: 'o/r', kind: 'issue', number: 3, milestone: '100% uptime' })
    await upsertEntity(db, { ...base, repo: 'o/r', kind: 'issue', number: 4, milestone: null })
    await upsertEntity(db, { ...base, repo: 'x/y', kind: 'issue', number: 5, milestone: 'Q4 Elsewhere' })

    expect(await suggestMilestones(db, 'o/r', 'q4', 10)).toEqual([{ ref: 'Q4 Checkout', title: 'Q4 Checkout' }])
    expect(await suggestMilestones(db, 'o/r', '', 10)).toEqual([
      { ref: '100% uptime', title: '100% uptime' },
      { ref: 'Q4 Checkout', title: 'Q4 Checkout' },
    ])
    // '%' is a literal, not a wildcard.
    expect(await suggestMilestones(db, 'o/r', '0%', 10)).toEqual([{ ref: '100% uptime', title: '100% uptime' }])
    expect(await suggestMilestones(db, 'o/r', '%', 10)).toEqual([{ ref: '100% uptime', title: '100% uptime' }])
  })
})
