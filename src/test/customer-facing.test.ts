import { describe, it, expect } from 'vitest'
import { classifyCustomerFacing } from '../lib/customer-facing'

describe('classifyCustomerFacing (fail-closed)', () => {
  it('defaults to false with no signals', () => {
    expect(
      classifyCustomerFacing({ labels: ['bug'], customerFacingLabels: [] })
    ).toBe(false)
  })

  it('is true when a configured label matches (case-insensitive)', () => {
    expect(
      classifyCustomerFacing({
        labels: ['Customer-Facing'],
        customerFacingLabels: ['customer-facing'],
      })
    ).toBe(true)
  })

  it('stays false when labels do not match the configured set', () => {
    expect(
      classifyCustomerFacing({
        labels: ['internal', 'chore'],
        customerFacingLabels: ['customer-facing'],
      })
    ).toBe(false)
  })

  it('trusts AI only when positive AND high-confidence', () => {
    const base = { labels: [] as string[], customerFacingLabels: [] as string[] }
    expect(
      classifyCustomerFacing({ ...base, aiHint: { customerFacing: true, confidence: 'high' } })
    ).toBe(true)
    expect(
      classifyCustomerFacing({ ...base, aiHint: { customerFacing: true, confidence: 'medium' } })
    ).toBe(false)
    expect(
      classifyCustomerFacing({ ...base, aiHint: { customerFacing: false, confidence: 'high' } })
    ).toBe(false)
  })
})

describe('classifyCustomerFacing — issue types (closed issues)', () => {
  it('is true when a closed issue type matches the configured set (case-insensitive)', () => {
    expect(
      classifyCustomerFacing({
        labels: [],
        customerFacingLabels: [],
        issueTypes: ['Bug'],
        customerFacingIssueTypes: ['bug'],
      })
    ).toBe(true)
  })

  it('stays false when issue types do not match, or none are configured', () => {
    expect(
      classifyCustomerFacing({
        labels: [],
        customerFacingLabels: [],
        issueTypes: ['Task'],
        customerFacingIssueTypes: ['bug'],
      })
    ).toBe(false)
    expect(
      classifyCustomerFacing({
        labels: [],
        customerFacingLabels: [],
        issueTypes: ['Bug'],
        customerFacingIssueTypes: [],
      })
    ).toBe(false)
  })

  it('omitted issue-type fields behave like empty (back-compat)', () => {
    expect(classifyCustomerFacing({ labels: ['x'], customerFacingLabels: ['y'] })).toBe(false)
  })
})
