/**
 * `customer_facing` classification — FAIL-CLOSED (§3, review V5). Defaults to
 * false (Dev-only) unless a positive signal says otherwise, so a wrong guess
 * hides a change from the CX lens rather than mislabeling an internal change as
 * customer-facing. Pure + testable.
 *
 * Signals, in order:
 *   1. A configured customer-facing label on the PR or any issue it closes.
 *   2. A configured issue type on any issue it closes (GitHub issue types).
 *   3. A high-confidence AI hint (only trusted when explicitly high-confidence).
 * Both label and issue-type sets are config (`CUSTOMER_FACING_LABELS`,
 * `CUSTOMER_FACING_ISSUE_TYPES`); AI is the soft fallback.
 */

export interface CustomerFacingInput {
  /** Labels on the PR and on every issue it closes. */
  labels: string[]
  /** Configured labels that mark a change customer-facing (lower-cased match). */
  customerFacingLabels: string[]
  /** GitHub issue types of the issues the PR closes. */
  issueTypes?: string[]
  /** Configured issue types that mark a change customer-facing (lower-cased match). */
  customerFacingIssueTypes?: string[]
  /** Optional AI classification; only `high` confidence flips the default. */
  aiHint?: { customerFacing: boolean; confidence: 'low' | 'medium' | 'high' }
}

function normalizedSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean))
}

function anyIn(values: string[] | undefined, configured: Set<string>): boolean {
  if (configured.size === 0) return false
  for (const v of values ?? []) {
    if (configured.has(v.trim().toLowerCase())) return true
  }
  return false
}

export function classifyCustomerFacing(input: CustomerFacingInput): boolean {
  if (anyIn(input.labels, normalizedSet(input.customerFacingLabels))) return true
  if (anyIn(input.issueTypes, normalizedSet(input.customerFacingIssueTypes))) return true
  // Trust AI only when it is BOTH positive AND high-confidence (fail-closed).
  if (input.aiHint && input.aiHint.customerFacing && input.aiHint.confidence === 'high') {
    return true
  }
  return false
}
