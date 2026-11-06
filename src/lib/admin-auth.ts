/**
 * Constant-time admin bearer-token check (spec §4). Web Crypto only: both sides
 * are SHA-256'd (fixed 32-byte digests, so length never leaks), then compared
 * with a no-early-exit XOR loop. Works in Workers and in Node tests.
 * Fail-closed: an unset or empty secret never matches.
 */
const PREFIX = 'Bearer '

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

export async function tokenMatches(authHeader: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret) return false
  if (!authHeader || !authHeader.startsWith(PREFIX)) return false
  const presented = authHeader.slice(PREFIX.length)
  if (presented === '') return false
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
