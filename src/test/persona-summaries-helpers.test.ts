import { describe, it, expect } from 'vitest'
import { parsePersonaJson, clampSummary, richness, stripPrSuffix, PERSONA_SUMMARY_VERSION, type SummaryInput } from '../ai/persona-summaries'
import { hashSummaryInput } from '../lib/helpers'

const input = (o: Partial<SummaryInput> = {}): SummaryInput => ({
  app: 'billing', role: 'developer', prTitle: 'Add a sharing toolkit for billing advertisers',
  releaseNote: null, labels: [], linkedIssueTitles: [], noteTechnical: null, ...o,
})

describe('parsePersonaJson', () => {
  it('parses a bare object', () => {
    expect(parsePersonaJson('{"headline":"H","body":"B"}')).toEqual({ headline: 'H', body: 'B' })
  })
  it('recovers an object embedded in prose (second attempt)', () => {
    expect(parsePersonaJson('Sure!\n{"headline":"H","body":null}\nHope that helps')).toEqual({ headline: 'H', body: null })
  })
  it('returns null when no valid headline', () => {
    expect(parsePersonaJson('not json at all')).toBeNull()
    expect(parsePersonaJson('{"body":"x"}')).toBeNull()
  })
})

describe('clampSummary', () => {
  it('truncates over-length headline and body with an ellipsis', () => {
    const r = clampSummary('x'.repeat(200), 'y'.repeat(500))
    expect(r.headline.length).toBeLessThanOrEqual(80)
    expect(r.body!.length).toBeLessThanOrEqual(240)
    expect(r.headline.endsWith('…')).toBe(true)
  })
  it('passes short strings through and null body stays null', () => {
    expect(clampSummary('short', null)).toEqual({ headline: 'short', body: null })
  })
})

describe('richness', () => {
  it('dev scores 1 on a 4+ word title alone', () => {
    expect(richness(input({ prTitle: 'add sharing toolkit now' }), 'developer')).toBeGreaterThanOrEqual(1)
  })
  it('cx needs >=2: a bare title (score 1) is below threshold, a release_note (score 2) passes', () => {
    expect(richness(input({ prTitle: 'add sharing toolkit now' }), 'cx')).toBe(1)
    expect(richness(input({ releaseNote: 'Advertisers can now share a toolkit' }), 'cx')).toBeGreaterThanOrEqual(2)
  })
  it('counts labels, linked issues, and a differing noteTechnical', () => {
    expect(richness(input({ labels: ['feature', 'billing'], linkedIssueTitles: ['x'], noteTechnical: 'diff' }), 'developer'))
      .toBe(2 + 1 + 1 + 1) // 2 labels + 1 issue + noteTechnical + 4word-title
  })
})

describe('stripPrSuffix', () => {
  it('removes a trailing (#N) squash suffix only', () => {
    expect(stripPrSuffix('Adds sharing toolkit (#42)')).toBe('Adds sharing toolkit')
    expect(stripPrSuffix('Fix bug in #42 handling')).toBe('Fix bug in #42 handling')
    expect(stripPrSuffix('No suffix here')).toBe('No suffix here')
  })
})

describe('hashSummaryInput', () => {
  it('is deterministic, folds in the version, and changes with version', async () => {
    const a = await hashSummaryInput(input(), PERSONA_SUMMARY_VERSION)
    const b = await hashSummaryInput(input(), PERSONA_SUMMARY_VERSION)
    const c = await hashSummaryInput(input(), 'v2-different')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})
