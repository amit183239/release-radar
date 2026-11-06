import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeAiProvider, GeminiAiProvider, estimateCents } from '../ai/provider'
import type { SummaryInput } from '../ai/persona-summaries'

const input: SummaryInput = {
  app: 'billing', role: 'developer', prTitle: 'Add a sharing toolkit for billing advertisers',
  releaseNote: 'Advertisers can invite billings in bulk', labels: ['feature'], linkedIssueTitles: [], noteTechnical: null,
}

function mockFetch(json: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })) as any
}
afterEach(() => vi.restoreAllMocks())

describe('makeAiProvider factory', () => {
  it('selects by AI_PROVIDER; unknown/off → off', () => {
    expect(makeAiProvider({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GITHUB_REPO: 'o/r' } as any).id).toBe('gemini')
    expect(makeAiProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', GITHUB_REPO: 'o/r' } as any).id).toBe('anthropic')
    expect(makeAiProvider({ AI_PROVIDER: 'off', GITHUB_REPO: 'o/r' } as any).id).toBe('off')
    expect(makeAiProvider({ GITHUB_REPO: 'o/r' } as any).id).toBe('off')
  })
})

describe('GeminiAiProvider', () => {
  it('parses a native-JSON candidate into a clamped SummaryResult', async () => {
    globalThis.fetch = mockFetch({
      candidates: [{ content: { parts: [{ text: '{"headline":"Adds billing sharing toolkit","body":"Lets advertisers invite billings in bulk"}' }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
    })
    const p = new GeminiAiProvider('key', 'gemini-2.5-flash')
    const r = await p.generatePersonaSummary(input)
    expect(r?.headline).toContain('billing')
    expect(r?.body).toBeTruthy()
    expect(r?.costCents).toBeGreaterThanOrEqual(1)
  })
  it('disables thinking (thinkingBudget: 0) so a reasoning model does not spend maxOutputTokens on thoughts', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"headline":"h","body":null}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = spy as any
    await new GeminiAiProvider('key', 'gemini-2.5-flash').generatePersonaSummary(input)
    const sentBody = JSON.parse((spy.mock.calls[0] as any[])[1].body)
    expect(sentBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })
  it('returns null on a blocked prompt, empty candidates, or non-JSON', async () => {
    globalThis.fetch = mockFetch({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })
    expect(await new GeminiAiProvider('key', 'gemini-2.5-flash').generatePersonaSummary(input)).toBeNull()
    globalThis.fetch = mockFetch({ candidates: [{ content: { parts: [{ text: 'sorry, no json' }] } }] })
    expect(await new GeminiAiProvider('key', 'gemini-2.5-flash').generatePersonaSummary(input)).toBeNull()
  })
  it('returns null on an HTTP error', async () => {
    globalThis.fetch = mockFetch({ error: 'nope' }, 500)
    expect(await new GeminiAiProvider('key', 'gemini-2.5-flash').generatePersonaSummary(input)).toBeNull()
  })
  it('returns null when constructed without a key (no fetch)', async () => {
    const spy = vi.fn()
    globalThis.fetch = spy as any
    expect(await new GeminiAiProvider(undefined, 'gemini-2.5-flash').generatePersonaSummary(input)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('estimateCents', () => {
  it('floors at 1 cent for tiny calls, on any known or unknown model', () => {
    expect(estimateCents('gemini-2.5-flash', 120, 30)).toBe(1)
    expect(estimateCents('claude-haiku-4-5-20251001', 120, 30)).toBe(1)
    expect(estimateCents('some-unknown-model', 120, 30)).toBeGreaterThanOrEqual(1)
  })
})
