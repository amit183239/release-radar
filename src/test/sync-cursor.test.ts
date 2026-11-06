import { describe, it, expect } from 'vitest'
import {
  SYNC_OVERLAP_SECONDS,
  epochToCursor,
  normalizeCursor,
  cursorToEpoch,
  nextSyncCursor,
} from '../lib/sync-cursor'

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000)

describe('cursor format', () => {
  it('epochToCursor pins YYYY-MM-DDTHH:MM:SSZ (no fractional seconds)', () => {
    expect(epochToCursor(T('2026-11-03T10:20:30Z'))).toBe('2026-11-03T10:20:30Z')
    expect(epochToCursor(T('2026-11-03T10:20:30Z'))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('normalizeCursor upgrades legacy date-only cursors and strips millis', () => {
    expect(normalizeCursor('2026-11-01')).toBe('2026-11-01T00:00:00Z')
    expect(normalizeCursor('2026-11-01T05:06:07.123Z')).toBe('2026-11-01T05:06:07Z')
    expect(normalizeCursor('2026-11-01T05:06:07Z')).toBe('2026-11-01T05:06:07Z')
  })

  it('normalizeCursor maps empty/garbage to null', () => {
    expect(normalizeCursor(null)).toBeNull()
    expect(normalizeCursor(undefined)).toBeNull()
    expect(normalizeCursor('')).toBeNull()
    expect(normalizeCursor('not-a-date')).toBeNull()
    expect(normalizeCursor('2026-13-45')).toBeNull()
  })

  it('cursorToEpoch round-trips and accepts legacy dates', () => {
    expect(cursorToEpoch('2026-11-03T10:20:30Z')).toBe(T('2026-11-03T10:20:30Z'))
    expect(cursorToEpoch('2026-11-01')).toBe(T('2026-11-01T00:00:00Z'))
    expect(() => cursorToEpoch('nope')).toThrow()
  })

  it('one overlap constant for both syncs', () => {
    expect(SYNC_OVERLAP_SECONDS).toBe(3600)
  })
})

describe('nextSyncCursor', () => {
  const prior = '2026-11-03T08:00:00Z'

  it('zero items seen -> prior unchanged (no wall-clock advance)', () => {
    expect(nextSyncCursor({ prior, maxSeen: null, overlapSeconds: 3600, capped: false })).toBe(prior)
    expect(nextSyncCursor({ prior: null, maxSeen: null, overlapSeconds: 3600, capped: false })).toBeNull()
  })

  it('not capped -> maxSeen minus overlap', () => {
    expect(
      nextSyncCursor({ prior, maxSeen: T('2026-11-03T12:00:00Z'), overlapSeconds: 3600, capped: false })
    ).toBe('2026-11-03T11:00:00Z')
  })

  it('never moves backward', () => {
    // maxSeen - overlap (07:30) is before prior (08:00) -> keep prior.
    expect(
      nextSyncCursor({ prior, maxSeen: T('2026-11-03T08:30:00Z'), overlapSeconds: 3600, capped: false })
    ).toBe(prior)
  })

  it('capped -> max(prior + 1, maxSeen - 60) so a capped window always progresses', () => {
    // maxSeen - 60 (08:00:30) > prior + 1 (08:00:01)
    expect(
      nextSyncCursor({ prior, maxSeen: T('2026-11-03T08:01:30Z'), overlapSeconds: 3600, capped: true })
    ).toBe('2026-11-03T08:00:30Z')
    // every item shares the prior second -> prior + 1 guarantees progress
    expect(
      nextSyncCursor({ prior, maxSeen: T('2026-11-03T08:00:00Z'), overlapSeconds: 3600, capped: true })
    ).toBe('2026-11-03T08:00:01Z')
  })

  it('capped with no prior -> maxSeen - 60', () => {
    expect(
      nextSyncCursor({ prior: null, maxSeen: T('2026-11-03T08:01:00Z'), overlapSeconds: 3600, capped: true })
    ).toBe('2026-11-03T08:00:00Z')
  })

  it('normalizes a legacy date-only prior before comparing (epoch, not string)', () => {
    expect(
      nextSyncCursor({ prior: '2026-11-03', maxSeen: T('2026-11-03T12:00:00Z'), overlapSeconds: 3600, capped: false })
    ).toBe('2026-11-03T11:00:00Z')
  })
})
