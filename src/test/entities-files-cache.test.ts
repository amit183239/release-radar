import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/d1'
import { upsertEntity, getCachedPrs } from '../lib/queries'

describe('entity file cache', () => {
  it('upsertEntity writes files_json and getCachedPrs returns it', async () => {
    const db = makeTestDb()
    await upsertEntity(db as any, {
      repo: 'o/r', kind: 'pr', number: 172, title: 'Fix consent banner flicker on first load',
      state: 'MERGED', author: 'dev', labels: ['bug', 'customer-facing'], updatedAt: 100,
      closes: [92], url: 'u172', files: ['apps/platform/web/src/consent-banner.ts'],
    })
    const pr = (await getCachedPrs(db as any, 'o/r', [172])).get(172)
    expect(pr?.files_json).toBe(JSON.stringify(['apps/platform/web/src/consent-banner.ts']))
  })
  it('omitting files stores NULL (unknown)', async () => {
    const db = makeTestDb()
    await upsertEntity(db as any, {
      repo: 'o/r', kind: 'pr', number: 5, title: 't', state: 'MERGED', author: null,
      labels: [], updatedAt: 1, closes: [], url: null,
    })
    const pr = (await getCachedPrs(db as any, 'o/r', [5])).get(5)
    expect(pr?.files_json ?? null).toBeNull()
  })
})
