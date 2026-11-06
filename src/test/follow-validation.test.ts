import { describe, it, expect } from 'vitest'
import { validateFollowInput } from '../lib/follow-validation'
import { createFollow } from '../lib/follows'
import { makeTestDb } from './helpers/d1'

describe('validateFollowInput', () => {
  it('rejects an unknown target_type', () => {
    expect(validateFollowInput({ target_type: 'feature', target_ref: 'x' })).toEqual({
      ok: false,
      error: 'invalid target_type',
    })
  })
  it('rejects a missing/blank target_ref and a non-object body', () => {
    expect(validateFollowInput({ target_type: 'pr', target_ref: '   ' }).ok).toBe(false)
    expect(validateFollowInput({ target_type: 'pr' }).ok).toBe(false)
    expect(validateFollowInput(null).ok).toBe(false)
  })
  it('trims target_ref', () => {
    const v = validateFollowInput({ target_type: 'label', target_ref: '  bug ' })
    expect(v).toEqual({ ok: true, value: { targetType: 'label', targetRef: 'bug', customerRef: null, ticketRef: null } })
  })
  it('query must be 3–200 chars after trimming', () => {
    expect(validateFollowInput({ target_type: 'query', target_ref: ' ab ' })).toEqual({
      ok: false,
      error: 'query must be 3-200 characters',
    })
    expect(validateFollowInput({ target_type: 'query', target_ref: 'x'.repeat(201) }).ok).toBe(false)
    expect(validateFollowInput({ target_type: 'query', target_ref: 'retry' }).ok).toBe(true)
  })
  it('other target types are capped at 200 chars', () => {
    expect(validateFollowInput({ target_type: 'milestone', target_ref: 'm'.repeat(201) })).toEqual({
      ok: false,
      error: 'target_ref too long',
    })
  })
  it('refs: trimmed, blank -> null, max 200, issue/pr only', () => {
    expect(
      validateFollowInput({ target_type: 'issue', target_ref: '92', customer_ref: ' ACME-1 ', ticket_ref: '' })
    ).toEqual({ ok: true, value: { targetType: 'issue', targetRef: '92', customerRef: 'ACME-1', ticketRef: null } })
    expect(
      validateFollowInput({ target_type: 'issue', target_ref: '92', customer_ref: 'c'.repeat(201) })
    ).toEqual({ ok: false, error: 'customer_ref too long' })
    // Refs on a non issue/pr target are ignored (stored as null).
    expect(
      validateFollowInput({ target_type: 'app', target_ref: 'checkout', customer_ref: 'ACME-1' })
    ).toEqual({ ok: true, value: { targetType: 'app', targetRef: 'checkout', customerRef: null, ticketRef: null } })
    // Non-string refs are ignored.
    expect(
      validateFollowInput({ target_type: 'pr', target_ref: '5', ticket_ref: 42 })
    ).toEqual({ ok: true, value: { targetType: 'pr', targetRef: '5', customerRef: null, ticketRef: null } })
  })
})

describe('issue/pr target_ref must be a positive integer', () => {
  it.each(['issue', 'pr'])('%s: canonicalizes #27 / 027 / padded', (t) => {
    for (const raw of ['#27', '027', ' 027 ', ' #27 ', '27']) {
      const v = validateFollowInput({ target_type: t, target_ref: raw })
      expect(v.ok && v.value.targetRef).toBe('27')
    }
  })
  it.each(['issue', 'pr'])('%s: rejects non-numeric / zero / double-hash', (t) => {
    for (const raw of ['PR-27', '0', '000', '##27', '#', '1.5', '-3', '12abc']) {
      expect(validateFollowInput({ target_type: t, target_ref: raw })).toEqual({
        ok: false,
        error: 'target_ref must be a PR/issue number',
      })
    }
  })
  it('does not affect other target types', () => {
    const v = validateFollowInput({ target_type: 'label', target_ref: '#27' })
    expect(v.ok && v.value.targetRef).toBe('#27')
  })
  // No auth-free route harness exists (requireAuth gates /api/follows), so the
  // route's validate -> createFollow path is exercised via the exported pieces.
  it('validator output stored via createFollow is the canonical ref', async () => {
    const db = makeTestDb()
    const v = validateFollowInput({ target_type: 'pr', target_ref: '#27' })
    if (!v.ok) throw new Error('expected ok')
    await createFollow(db as any, { userId: 'u1', targetType: v.value.targetType, targetRef: v.value.targetRef })
    const rows = (await db.prepare('SELECT target_ref FROM follows').all()).results as any[]
    expect(rows.map((r) => r.target_ref)).toEqual(['27'])
  })
})
