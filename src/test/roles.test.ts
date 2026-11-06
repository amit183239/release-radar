import { describe, it, expect } from 'vitest'
import { ROLES, getRole, isRoleKey, noteMatchesRole, DEFAULT_ROLE } from '../lib/roles'

describe('role registry', () => {
  it('has unique keys and valid voice/grouping', () => {
    const keys = ROLES.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['developer', 'cx', 'support', 'sales', 'pm'])
    for (const r of ROLES) {
      expect(['technical', 'customer']).toContain(r.voice)
      expect(['release', 'milestone']).toContain(r.grouping)
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.insights.cards.length).toBeGreaterThan(0)
    }
  })

  it('isRoleKey validates against the registry', () => {
    expect(isRoleKey('cx')).toBe(true)
    expect(isRoleKey('nope')).toBe(false)
  })

  it('getRole falls back to the default for unknown/null', () => {
    expect(getRole('pm').key).toBe('pm')
    expect(getRole('nope').key).toBe(DEFAULT_ROLE)
    expect(getRole(null).key).toBe(DEFAULT_ROLE)
  })

  const cf = (customer_facing: number, labels: string[] = []) => ({ customer_facing, labels })

  it('developer sees everything', () => {
    expect(noteMatchesRole(cf(0, ['bug']), getRole('developer'))).toBe(true)
    expect(noteMatchesRole(cf(1, []), getRole('developer'))).toBe(true)
  })

  it('cx requires customer_facing', () => {
    expect(noteMatchesRole(cf(1, []), getRole('cx'))).toBe(true)
    expect(noteMatchesRole(cf(0, ['feature']), getRole('cx'))).toBe(false)
  })

  it('support is OR: customer-facing OR bug/regression/breaking-change', () => {
    expect(noteMatchesRole(cf(0, ['bug']), getRole('support'))).toBe(true)
    expect(noteMatchesRole(cf(1, ['docs']), getRole('support'))).toBe(true)
    expect(noteMatchesRole(cf(0, ['feature']), getRole('support'))).toBe(false)
  })

  it('sales is AND: customer-facing AND feature/enhancement (no pure fixes)', () => {
    expect(noteMatchesRole(cf(1, ['feature']), getRole('sales'))).toBe(true)
    expect(noteMatchesRole(cf(1, ['bug']), getRole('sales'))).toBe(false)     // fix, not highlight
    expect(noteMatchesRole(cf(0, ['feature']), getRole('sales'))).toBe(false) // not customer-facing
  })

  it('label matching is case-insensitive', () => {
    expect(noteMatchesRole(cf(0, ['Bug']), getRole('support'))).toBe(true)
  })

  it('pm is OR: customer-facing OR feature/enhancement/breaking-change', () => {
    expect(noteMatchesRole(cf(0, ['feature']), getRole('pm'))).toBe(true)      // label match, OR
    expect(noteMatchesRole(cf(1, []), getRole('pm'))).toBe(true)               // customer-facing, OR
    expect(noteMatchesRole(cf(0, ['bug']), getRole('pm'))).toBe(false)         // neither
  })
})
