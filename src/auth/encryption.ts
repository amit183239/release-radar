/**
 * AES-256-GCM encrypt/decrypt for secrets at rest (OAuth OAuth token blobs).
 * Web Crypto only — no Node crypto. Ciphertext format: base64( iv(12) || ct ).
 * The key is a base64-encoded 32-byte value in SESSION_ENCRYPTION_KEY.
 */

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (ch) => ch.charCodeAt(0))
  if (raw.length !== 32) {
    throw new Error(
      `SESSION_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}`
    )
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export async function encrypt(
  plaintext: string,
  base64Key: string
): Promise<string> {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    )
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return toBase64(out)
}

export async function decrypt(
  ciphertextB64: string,
  base64Key: string
): Promise<string> {
  const key = await importKey(base64Key)
  const bytes = Uint8Array.from(atob(ciphertextB64), (ch) => ch.charCodeAt(0))
  if (bytes.length < 13) throw new Error('ciphertext too short')
  const iv = bytes.slice(0, 12)
  const ct = bytes.slice(12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}
