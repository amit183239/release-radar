// src/test/events.test.ts
import { describe, it, expect } from 'vitest'
import { pickShipMatch, type ShipMatchRow } from '../lib/events'

describe('pickShipMatch', () => {
  it('keeps the highest-priority (lowest number) match per user', () => {
    const rows: ShipMatchRow[] = [
      { user_id: 'u1', matched_type: 'app', matched_ref: 'billing', priority: 6 },
      { user_id: 'u1', matched_type: 'pr', matched_ref: '99', priority: 1 },
      { user_id: 'u2', matched_type: 'label', matched_ref: 'bug', priority: 4 },
    ]
    const m = pickShipMatch(rows)
    expect(m.get('u1')).toEqual({ matched_type: 'pr', matched_ref: '99' })
    expect(m.get('u2')).toEqual({ matched_type: 'label', matched_ref: 'bug' })
    expect(m.size).toBe(2)
  })

  it('is order-independent (later lower-priority row does not override)', () => {
    const m = pickShipMatch([
      { user_id: 'u1', matched_type: 'pr', matched_ref: '5', priority: 1 },
      { user_id: 'u1', matched_type: 'app', matched_ref: 'x', priority: 6 },
    ])
    expect(m.get('u1')).toEqual({ matched_type: 'pr', matched_ref: '5' })
  })

  it('issue beats label for the same user', () => {
    const m = pickShipMatch([
      { user_id: 'u1', matched_type: 'label', matched_ref: 'bug', priority: 4 },
      { user_id: 'u1', matched_type: 'issue', matched_ref: '42', priority: 2 },
    ])
    expect(m.get('u1')).toEqual({ matched_type: 'issue', matched_ref: '42' })
  })

  it('empty in → empty out', () => {
    expect(pickShipMatch([]).size).toBe(0)
  })
})
