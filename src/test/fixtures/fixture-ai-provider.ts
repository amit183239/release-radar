import type { AiProvider, GenerateResult } from '../../ai/provider'
import type { SummaryInput, SummaryResult } from '../../ai/persona-summaries'

export class FixtureAiProvider implements AiProvider {
  readonly id = 'fixture'
  calls = { developer: 0, cx: 0 }
  constructor(private opts: { costCents?: number; failOn?: (i: SummaryInput) => boolean } = {}) {}
  async generateCustomerNote(): Promise<GenerateResult | null> { return null }
  async generatePersonaSummary(input: SummaryInput): Promise<SummaryResult | null> {
    this.calls[input.role as 'developer' | 'cx']++
    if (this.opts.failOn?.(input)) return null
    return { headline: `${input.role}:${input.prTitle}`.slice(0, 80), body: input.releaseNote, costCents: this.opts.costCents ?? 1 }
  }
}
