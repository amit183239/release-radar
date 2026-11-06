import { describe, it, expect } from 'vitest'
import { detectActivity } from '../lib/activity'

describe('detectActivity', () => {
  it('first sighting (no prior row) is never activity', () => {
    expect(detectActivity(undefined, { state: 'CLOSED', commentsCount: 9 })).toBeNull()
  })

  it('no change is null', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: 2 }, { state: 'OPEN', commentsCount: 2 })).toBeNull()
  })

  it('state change OPEN -> CLOSED', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: 2 }, { state: 'CLOSED', commentsCount: 2 })).toEqual({
      stateFrom: 'OPEN',
      stateTo: 'CLOSED',
    })
  })

  it('state change CLOSED -> OPEN (reopen) and OPEN -> MERGED', () => {
    expect(detectActivity({ state: 'CLOSED', comments_count: 0 }, { state: 'OPEN', commentsCount: 0 })).toEqual({
      stateFrom: 'CLOSED',
      stateTo: 'OPEN',
    })
    expect(detectActivity({ state: 'OPEN', comments_count: 0 }, { state: 'MERGED', commentsCount: 0 })).toEqual({
      stateFrom: 'OPEN',
      stateTo: 'MERGED',
    })
  })

  it('comment increase reports the delta', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: 2 }, { state: 'OPEN', commentsCount: 5 })).toEqual({
      newComments: 3,
    })
  })

  it('state change + comments combine', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: 1 }, { state: 'CLOSED', commentsCount: 2 })).toEqual({
      stateFrom: 'OPEN',
      stateTo: 'CLOSED',
      newComments: 1,
    })
  })

  it('NULL prior comments_count (pre-0008 row) is a baseline, not a comment flood', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: null }, { state: 'OPEN', commentsCount: 40 })).toBeNull()
  })

  it('NULL prior comments_count still reports a state change', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: null }, { state: 'CLOSED', commentsCount: 40 })).toEqual({
      stateFrom: 'OPEN',
      stateTo: 'CLOSED',
    })
  })

  it('comment decrease (deletions) is not activity', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: 5 }, { state: 'OPEN', commentsCount: 3 })).toBeNull()
  })

  it('unknown next comment count is not a comment event', () => {
    expect(detectActivity({ state: 'OPEN', comments_count: 5 }, { state: 'OPEN', commentsCount: null })).toBeNull()
  })

  it('NULL prior state does not invent a state change', () => {
    expect(detectActivity({ state: null, comments_count: 1 }, { state: 'OPEN', commentsCount: 1 })).toBeNull()
  })
})
