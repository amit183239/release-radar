import { describe, it, expect } from 'vitest'
import { escapeLike, noteMatchesQuery } from '../lib/search'

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape char', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x')
  })
})

describe('noteMatchesQuery (mirrors SQLite LIKE: ASCII-case-insensitive substring)', () => {
  it('matches a case-insensitive substring', () => {
    expect(noteMatchesQuery('Fix Webhook retry storm', 'webhook RETRY')).toBe(true)
  })
  it('trims the query', () => {
    expect(noteMatchesQuery('Fix webhook retry', '  retry  ')).toBe(true)
  })
  it('never matches an empty query or a null note', () => {
    expect(noteMatchesQuery('anything', '   ')).toBe(false)
    expect(noteMatchesQuery(null, 'retry')).toBe(false)
  })
  it('treats LIKE wildcards literally', () => {
    expect(noteMatchesQuery('100 percent', '%')).toBe(false)
    expect(noteMatchesQuery('save 50% now', '50%')).toBe(true)
  })
  it('folds ASCII only (non-ASCII matches case-sensitively, like SQLite LIKE)', () => {
    expect(noteMatchesQuery('Ärger fixed', 'ärger')).toBe(false)
    expect(noteMatchesQuery('Ärger fixed', 'Ärger')).toBe(true)
  })
})
