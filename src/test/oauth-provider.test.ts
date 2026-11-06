import { describe, it, expect, vi, afterEach } from 'vitest'
import { OAuthProvider } from '../auth/oauth/provider'
import type { Env } from '../env'

/**
 * Regression for the "email_unverified denies every real user" bug: the provider's
 * /v1/user/overview returns NO email-verification field (confirmed against the
 * live payload + the billing reference). Completing the OAuth flow IS the provider's
 * attestation, so the provider must report emailVerified:true when the field is
 * absent — while still honoring an explicit negative if OAuth ever adds one.
 */
function makeEnv(): Env {
  return {
    OAUTH_API_URL: 'https://platform.test',
    OAUTH_UI_URL: 'https://ui.platform.test',
    OAUTH_CLIENT_ID: 'cid',
    OAUTH_CLIENT_SECRET: 'secret',
    DEBUG: 'false',
  } as unknown as Env
}

function mockFetch(overview: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/v1/oauth-app/client/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (url.endsWith('/v1/user/overview')) {
      return new Response(JSON.stringify(overview), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  })
}

describe('OAuthProvider.exchangeCode — email verification attestation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('attests verified when the overview omits the field (OAuth real contract)', async () => {
    vi.stubGlobal('fetch', mockFetch({ userId: 'u1', email: 'User@Example.com' }))
    const profile = await new OAuthProvider(makeEnv()).exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'https://app/cb',
    })
    expect(profile.emailVerified).toBe(true)
    expect(profile.email).toBe('user@example.com') // provider lower-cases
    expect(profile.providerUserId).toBe('u1')
  })

  it('honors an explicit negative if OAuth ever returns emailVerified:false', async () => {
    vi.stubGlobal('fetch', mockFetch({ userId: 'u2', email: 'x@example.com', emailVerified: false }))
    const profile = await new OAuthProvider(makeEnv()).exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'https://app/cb',
    })
    expect(profile.emailVerified).toBe(false)
  })
})
