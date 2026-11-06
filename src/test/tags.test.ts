import { describe, it, expect } from 'vitest'
import {
  parseSquashPr,
  buildChain,
  enumeratePrNumbers,
  isDivergent,
} from '../lib/tags'
import type { ResolvedTag } from '../lib/github'

describe('parseSquashPr', () => {
  it('extracts the trailing (#N) from a squash subject', () => {
    expect(parseSquashPr('Add OAuth login (#123)')).toBe(123)
  })
  it('ignores (#N) that is not the subject suffix (revert case)', () => {
    expect(parseSquashPr('Revert "Add OAuth login (#123)"')).toBeNull()
  })
  it('ignores (#N) mentioned only in the body', () => {
    expect(parseSquashPr('Fix bug\n\nRelates to (#45)')).toBeNull()
  })
  it('returns null when there is no PR suffix', () => {
    expect(parseSquashPr('chore: bump deps')).toBeNull()
  })
  it('tolerates trailing whitespace after the suffix', () => {
    expect(parseSquashPr('Ship it (#7)   ')).toBe(7)
  })
})

describe('enumeratePrNumbers', () => {
  it('collects unique PR numbers in first-seen order, skipping non-squash commits', () => {
    const commits = [
      { message: 'A (#10)' },
      { message: 'direct push, no pr' },
      { message: 'B (#12)' },
      { message: 'A again (#10)' }, // dup
    ]
    expect(enumeratePrNumbers(commits)).toEqual([10, 12])
  })
})

describe('buildChain', () => {
  const tag = (name: string, sha: string, at: number): ResolvedTag => ({
    name,
    commitSha: sha,
    createdAt: at,
    lightweight: false,
  })

  it('chains consecutive pairs ordered by tag-creation time', () => {
    const tags = [
      tag('billing-r3-production', 'c3', 300),
      tag('billing-r1-production', 'c1', 100),
      tag('billing-r2-production', 'c2', 200),
    ]
    const chain = buildChain(tags, null)
    expect(chain.map((p) => p.headSha)).toEqual(['c1', 'c2', 'c3'])
    // First tag has no predecessor; subsequent bases chain backwards.
    expect(chain.map((p) => p.baseSha)).toEqual([null, 'c1', 'c2'])
    expect(chain.map((p) => p.deployedAt)).toEqual([100, 200, 300])
  })

  it('only emits tags strictly newer than sinceAt, anchoring the base on the predecessor', () => {
    const tags = [
      tag('a-r1-production', 'c1', 100),
      tag('a-r2-production', 'c2', 200),
      tag('a-r3-production', 'c3', 300),
    ]
    const chain = buildChain(tags, 200) // last_ref was c2@200
    expect(chain).toHaveLength(1)
    expect(chain[0]).toMatchObject({ headSha: 'c3', baseSha: 'c2' })
  })

  it('orders deterministically by name when timestamps tie', () => {
    const tags = [
      tag('a-b-production', 'cb', 100),
      tag('a-a-production', 'ca', 100),
    ]
    const chain = buildChain(tags, null)
    expect(chain.map((p) => p.headSha)).toEqual(['ca', 'cb'])
  })
})

describe('isDivergent', () => {
  it('is true only for a diverged compare status', () => {
    expect(isDivergent('diverged')).toBe(true)
    expect(isDivergent('ahead')).toBe(false)
    expect(isDivergent('identical')).toBe(false)
  })
})
