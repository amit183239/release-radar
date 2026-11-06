import { describe, it, expect } from 'vitest'
import { clampInt, parseLabels } from '../lib/http'

describe('clampInt', () => {
  it('defaults on missing, non-numeric, zero, or negative input', () => {
    expect(clampInt(undefined, 50, 200)).toBe(50)
    expect(clampInt('abc', 10, 25)).toBe(10)
    expect(clampInt('0', 10, 25)).toBe(10)
    expect(clampInt('-3', 10, 25)).toBe(10)
  })
  it('passes through in-range values and caps at max', () => {
    expect(clampInt('7', 10, 25)).toBe(7)
    expect(clampInt('25', 10, 25)).toBe(25)
    expect(clampInt('999', 50, 200)).toBe(200)
  })
})

describe('parseLabels', () => {
  it('returns string labels only, [] on null/garbage/non-array', () => {
    expect(parseLabels('["bug","ux"]')).toEqual(['bug', 'ux'])
    expect(parseLabels('["bug", 3, null, "ux"]')).toEqual(['bug', 'ux'])
    expect(parseLabels(null)).toEqual([])
    expect(parseLabels('{not json')).toEqual([])
    expect(parseLabels('{"a":1}')).toEqual([])
  })
})
