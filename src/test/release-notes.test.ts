import { describe, it, expect } from 'vitest'
import { extractReleaseNote } from '../lib/release-notes'

describe('extractReleaseNote', () => {
  it('extracts the ## Release Note section up to the next heading', () => {
    const body = [
      'Some PR description.',
      '',
      '## Release Note',
      'Adds SSO login for admins.',
      'Second line of the note.',
      '',
      '## Testing',
      'Ran the suite.',
    ].join('\n')
    expect(extractReleaseNote(body)).toEqual({
      curated: 'Adds SSO login for admins.\nSecond line of the note.',
      skip: false,
    })
  })

  it('is heading-level and singular/plural insensitive', () => {
    expect(extractReleaseNote('### Release Notes\nCopy here').curated).toBe(
      'Copy here'
    )
  })

  it('honors the skip-release-note marker', () => {
    const r = extractReleaseNote('nothing to see\nskip-release-note')
    expect(r).toEqual({ curated: null, skip: true })
  })

  it('returns null curated when there is no section', () => {
    expect(extractReleaseNote('just a description')).toEqual({
      curated: null,
      skip: false,
    })
  })

  it('returns null curated for an empty section', () => {
    expect(extractReleaseNote('## Release Note\n\n## Next').curated).toBeNull()
  })

  it('handles null/undefined bodies', () => {
    expect(extractReleaseNote(null)).toEqual({ curated: null, skip: false })
    expect(extractReleaseNote(undefined)).toEqual({ curated: null, skip: false })
  })
})
