import { describe, it, expect } from 'vitest'
import { mapChangelogNote } from '../routes/api'

const base = {
  pr_number: 1,
  note_technical: 'tech',
  note_customer: null as string | null,
  customer_source: null as string | null,
  ps_headline: null as string | null,
  ps_body: null as string | null,
  ps_source: null as string | null,
}

describe('mapChangelogNote', () => {
  it('customer voice prefers persona_summaries.cx (ai) as "headline — body"', () => {
    const r = mapChangelogNote(
      { ...base, ps_headline: 'You can bulk-invite billings', ps_body: 'Saves time onboarding', ps_source: 'ai' },
      'customer',
    )
    expect(r.note).toBe('You can bulk-invite billings — Saves time onboarding')
    expect(r.customer_source).toBe('ai')
  })

  it('customer voice uses headline alone when no body', () => {
    const r = mapChangelogNote(
      { ...base, ps_headline: 'You can bulk-invite billings', ps_body: null, ps_source: 'ai' },
      'customer',
    )
    expect(r.note).toBe('You can bulk-invite billings')
    expect(r.customer_source).toBe('ai')
  })

  it('customer voice falls back to legacy note_customer when no ps row', () => {
    const r = mapChangelogNote({ ...base, note_customer: 'legacy copy' }, 'customer')
    expect(r.note).toBe('legacy copy')
    expect(r.customer_source).toBe('ai') // populated legacy note_customer with null source → 'ai'
  })

  it('customer voice falls back to note_technical when no ps row and no note_customer', () => {
    const r = mapChangelogNote({ ...base }, 'customer')
    expect(r.note).toBe('tech')
    expect(r.customer_source).toBe('fallback')
  })

  it('developer voice always gets note_technical', () => {
    const r = mapChangelogNote({ ...base, ps_headline: 'ignored', ps_source: 'ai' }, 'technical')
    expect(r.note).toBe('tech')
  })

  it('developer voice passes through customer_source unchanged', () => {
    const r = mapChangelogNote({ ...base, customer_source: 'human' }, 'technical')
    expect(r.customer_source).toBe('human')
  })
})
