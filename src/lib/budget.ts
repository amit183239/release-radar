/**
 * Per-tick D1 query budget (spec §0e). D1 allows ~1,000 queries per Worker
 * invocation (paid plan). The poll threads one QueryBudget through the tick and
 * call sites `spend(n)` explicitly; processTags stops cleanly BETWEEN compare
 * pairs once it is spent. A safety valve, not an exact meter.
 */
export const DEFAULT_QUERY_BUDGET = 800

export class QueryBudget {
  private used = 0

  constructor(private readonly limit: number = DEFAULT_QUERY_BUDGET) {}

  spend(n = 1): void {
    this.used += n
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used)
  }

  get exhausted(): boolean {
    return this.used >= this.limit
  }
}
