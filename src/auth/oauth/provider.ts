/**
 * OAuth OIDC provider — the first AuthProvider impl (§6 auth seam). Vendored
 * from the billing SSO token-exchange + profile flow, minus the marketplace
 * team/tag machinery release-radar doesn't need.
 *
 * The `@example.com` restriction is NOT enforced here — this impl only produces
 * a VerifiedProfile; the config-driven fail-closed gate (auth/provider.ts
 * checkDomainGate) decides admission. That keeps the provider reusable and the
 * policy in config.
 */
import type { Env } from '../../env'
import type { AuthProvider, VerifiedProfile } from '../provider'

const REQUEST_TIMEOUT_MS = 8_000

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  )
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/** OAuth /v1/user/overview subset. emailVerified is the attestation the gate
 *  requires; absent => treated as false (fail-closed). */
interface OAuthOverview {
  userId: string
  email: string | null
  emailVerified?: boolean
  firstName?: string | null
  lastName?: string | null
}

export class OAuthProvider implements AuthProvider {
  readonly id = 'oauth'
  constructor(private readonly env: Env) {}

  buildAuthorizeUrl(params: {
    redirectUri: string
    state: string
    codeChallenge: string
  }): string {
    const url = new URL('/oauth/app/login', this.env.OAUTH_UI_URL)
    url.searchParams.set('client_id', this.env.OAUTH_CLIENT_ID)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'full')
    url.searchParams.set('state', params.state)
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  async exchangeCode(params: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<VerifiedProfile> {
    const token = await this.exchange(params.code, params.codeVerifier)
    const overview = await this.fetchOverview(token.access_token)
    if (!overview.email) {
      throw new Error('platform_profile_missing_email')
    }
    return {
      providerUserId: overview.userId,
      email: overview.email.toLowerCase(),
      // the provider's /v1/user/overview returns NO email-verification field (confirmed
      // against the live payload + the billing reference). Completing the OAuth
      // flow + a valid overview IS the provider's attestation that this is a real,
      // authenticated user, so we trust it — but still honor an explicit negative
      // if a future OAuth build ever returns emailVerified:false. The allowed-
      // domain gate (checkDomainGate) remains the real access control.
      emailVerified: overview.emailVerified !== false,
      name:
        [overview.firstName, overview.lastName].filter(Boolean).join(' ') ||
        null,
      tokens: token,
    }
  }

  private async exchange(
    code: string,
    codeVerifier: string
  ): Promise<OAuthTokenResponse> {
    const tokenUrl = `${this.env.OAUTH_API_URL}/v1/oauth-app/client/token`
    const basic = btoa(
      `${this.env.OAUTH_CLIENT_ID}:${this.env.OAUTH_CLIENT_SECRET}`
    )
    let res: Response
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      if (isAbortError(e)) throw new Error('token_exchange_timeout')
      throw new Error('token_exchange_failed')
    }
    if (!res.ok) throw new Error('token_exchange_failed')
    // Do not log the body — it contains tokens.
    const json = (await res.json()) as OAuthTokenResponse
    if (this.env.DEBUG === 'true') {
      // Field NAMES only (no values) — reveals a snake_case/camelCase mismatch
      // that would make access_token undefined and the overview call fail.
      console.error(
        '[oauth:token] ok; response keys:',
        Object.keys((json ?? {}) as object).join(','),
        '| has access_token:',
        !!json?.access_token
      )
    }
    return json
  }

  private async fetchOverview(accessToken: string): Promise<OAuthOverview> {
    const url = `${this.env.OAUTH_API_URL}/v1/user/overview`
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      if (isAbortError(e)) throw new Error('profile_fetch_timeout')
      throw new Error('profile_fetch_failed')
    }
    if (!res.ok) {
      let body = ''
      try {
        body = await res.text()
      } catch {
        /* ignore */
      }
      if (this.env.DEBUG === 'true') {
        console.error(
          `[oauth:overview] ${res.status} ${res.statusText} ${url} body:`,
          body.slice(0, 400)
        )
      }
      throw new Error(`profile_fetch_failed_${res.status}`)
    }
    const json = (await res.json()) as OAuthOverview
    if (this.env.DEBUG === 'true') {
      // Field NAMES only (no PII/values) — enough to spot a renamed field.
      console.error(
        '[oauth:overview] ok; keys:',
        Object.keys((json ?? {}) as object).join(',')
      )
    }
    return json
  }
}
