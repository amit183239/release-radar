/**
 * PKCE (RFC 7636) + OAuth CSRF-state helpers. Vendored from the billing SSO
 * flow. Web Crypto only.
 */

export function generateCodeVerifier(): string {
  const buffer = new Uint8Array(32)
  crypto.getRandomValues(buffer)
  return base64Url(buffer)
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64Url(new Uint8Array(digest))
}

/** 32-byte hex nonce for the OAuth `state` param, bound to the browser cookie. */
export function generateStateNonce(): string {
  const buffer = new Uint8Array(32)
  crypto.getRandomValues(buffer)
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Constant-time string compare. Returns false immediately on length mismatch
 * (state nonces are fixed length, so the timing oracle has nothing to exploit),
 * otherwise iterates the full length so timing doesn't leak which byte differs.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function base64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
