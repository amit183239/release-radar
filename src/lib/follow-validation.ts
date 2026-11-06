/**
 * Server-side follow input validation — the source of truth (the UI mirrors
 * it). Spec §1b + §2d: target_ref trimmed; `query` 3–200 chars; every other
 * type ≤ 200. customer_ref / ticket_ref are opaque, internal-only text:
 * trimmed, '' -> NULL (so a blank form field never wipes a stored ref via the
 * re-follow COALESCE), ≤ 200 chars, accepted only for issue / pr targets.
 */
import { isFollowTargetType, type FollowTargetType } from './follows'

const MAX_REF = 200
const QUERY_MIN = 3

export type FollowInput = {
  targetType: FollowTargetType
  targetRef: string
  customerRef: string | null
  ticketRef: string | null
}

type Result = { ok: true; value: FollowInput } | { ok: false; error: string }

/** Normalize an optional ref: non-string/blank -> null; too long -> error. */
function normRef(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (typeof v !== 'string') return { ok: true, value: null }
  const t = v.trim()
  if (t === '') return { ok: true, value: null }
  if (t.length > MAX_REF) return { ok: false }
  return { ok: true, value: t }
}

export function validateFollowInput(body: unknown): Result {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const targetType = b.target_type
  if (typeof targetType !== 'string' || !isFollowTargetType(targetType)) {
    return { ok: false, error: 'invalid target_type' }
  }
  if (typeof b.target_ref !== 'string' || b.target_ref.trim() === '') {
    return { ok: false, error: 'invalid target_ref' }
  }
  let targetRef = b.target_ref.trim()
  if (targetType === 'issue' || targetType === 'pr') {
    // Strip ONE leading '#', require a positive integer, store canonically.
    const digits = targetRef.startsWith('#') ? targetRef.slice(1) : targetRef
    if (!/^\d+$/.test(digits) || !Number.isSafeInteger(Number(digits)) || Number(digits) < 1) {
      return { ok: false, error: 'target_ref must be a PR/issue number' }
    }
    targetRef = String(Number(digits))
  }
  if (targetType === 'query' && (targetRef.length < QUERY_MIN || targetRef.length > MAX_REF)) {
    return { ok: false, error: 'query must be 3-200 characters' }
  }
  if (targetRef.length > MAX_REF) return { ok: false, error: 'target_ref too long' }

  let customerRef: string | null = null
  let ticketRef: string | null = null
  if (targetType === 'issue' || targetType === 'pr') {
    const c = normRef(b.customer_ref)
    if (!c.ok) return { ok: false, error: 'customer_ref too long' }
    const t = normRef(b.ticket_ref)
    if (!t.ok) return { ok: false, error: 'ticket_ref too long' }
    customerRef = c.value
    ticketRef = t.value
  }
  return { ok: true, value: { targetType, targetRef, customerRef, ticketRef } }
}
