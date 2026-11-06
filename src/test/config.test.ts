import { describe, it, expect } from 'vitest'
import { tagRegexForApp, tagRegexAnyApp, resolveConfig } from '../config'
import { checkDomainGate } from '../auth/provider'

// Minimal env that satisfies resolveConfig's requireVar calls.
const base = {
  GITHUB_REPO: 'o/r',
  RELEASE_TAG_PATTERN: '{app}-*-production',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  MAPPING_JSON_PATH: '.github/mapping.json',
  SHARED_LIB_BUCKET: 'platform',
  BACKFILL_DAYS: '90',
} as any

describe('tag pattern compilation', () => {
  it('matches an app-specific prod tag and rejects others', () => {
    const re = tagRegexForApp('{app}-*-production', 'billing')
    expect(re.test('billing-2026.08.17-production')).toBe(true)
    expect(re.test('platform-2026.08.17-production')).toBe(false)
    expect(re.test('billing-2026.08.17-sandbox')).toBe(false)
  })

  it('captures the app slug from any prod tag (non-greedy first segment)', () => {
    const re = tagRegexAnyApp('{app}-*-production')
    expect(re.exec('billing-r12-production')?.[1]).toBe('billing')
    expect(re.exec('platform-2026-01-01-production')?.[1]).toBe('platform')
    expect(re.exec('random-tag')).toBeNull()
  })
})

describe('AI provider + model config', () => {
  it('defaults to off with no model call needed', () => {
    const c = resolveConfig({ ...base })
    expect(c.aiProvider).toBe('off')
  })
  it('unknown provider falls back to off (fail-safe)', () => {
    expect(resolveConfig({ ...base, AI_PROVIDER: 'bogus' }).aiProvider).toBe('off')
  })
  it('gemini defaults model to gemini-2.5-flash', () => {
    const c = resolveConfig({ ...base, AI_PROVIDER: 'gemini' })
    expect(c.aiProvider).toBe('gemini')
    expect(c.aiModel).toBe('gemini-2.5-flash')
  })
  it('anthropic defaults model to claude-haiku-4-5-20251001', () => {
    expect(resolveConfig({ ...base, AI_PROVIDER: 'anthropic' }).aiModel).toBe('claude-haiku-4-5-20251001')
  })
  it('AI_MODEL overrides the per-provider default', () => {
    expect(resolveConfig({ ...base, AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-2.5-pro' }).aiModel).toBe('gemini-2.5-pro')
  })
})

describe('checkDomainGate (fail-closed)', () => {
  const allowed = ['example.com']

  it('admits a verified email in an allowed domain', () => {
    expect(
      checkDomainGate({ email: 'user@example.com', emailVerified: true }, allowed)
    ).toEqual({ allowed: true })
  })
  it('denies an unverified email even in an allowed domain', () => {
    expect(
      checkDomainGate({ email: 'user@example.com', emailVerified: false }, allowed)
    ).toMatchObject({ allowed: false, reason: 'email_unverified' })
  })
  it('denies a verified email in a disallowed domain', () => {
    expect(
      checkDomainGate({ email: 'x@evil.com', emailVerified: true }, allowed)
    ).toMatchObject({ allowed: false, reason: 'domain_not_allowed' })
  })
  it('denies a missing email', () => {
    expect(
      checkDomainGate({ email: '', emailVerified: true }, allowed)
    ).toMatchObject({ allowed: false, reason: 'email_missing' })
  })
  it('is case-insensitive on the domain', () => {
    expect(
      checkDomainGate({ email: 'User@Example.COM', emailVerified: true }, allowed)
    ).toEqual({ allowed: true })
  })
})

describe('CUSTOMER_FACING_ISSUE_TYPES', () => {
  it('defaults to an empty list (fail-closed)', () => {
    expect(resolveConfig({ ...base }).customerFacingIssueTypes).toEqual([])
  })
  it('parses a comma list, trimmed and lower-cased', () => {
    expect(
      resolveConfig({ ...base, CUSTOMER_FACING_ISSUE_TYPES: ' Bug, Feature ,,' }).customerFacingIssueTypes
    ).toEqual(['bug', 'feature'])
  })
})
