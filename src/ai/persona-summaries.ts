export type SummaryRole = 'developer' | 'cx'

export interface SummaryInput {
  app: string
  role: SummaryRole
  prTitle: string
  releaseNote: string | null
  labels: string[]
  linkedIssueTitles: string[]
  noteTechnical: string | null
}

export interface SummaryResult {
  headline: string
  body: string | null
  costCents: number
}

// Bumping re-generates every ai row via the admin re-drain (§6.2b). Datestamped so a
// spend spike correlates to the deploy that changed prompts/inputs.
export const PERSONA_SUMMARY_VERSION = 'v1-20260901'

export const MIN_RICHNESS_DEV = 1 // §3.1 may raise to 2 as `## Release Note` adoption grows
export const MIN_RICHNESS_CX = 2  // cx cannot describe a customer benefit from a bare title without hallucinating

const HEADLINE_MAX = 80
const BODY_MAX = 240

function clampOne(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

export function clampSummary(headline: string, body: string | null): { headline: string; body: string | null } {
  return { headline: clampOne(headline, HEADLINE_MAX), body: body == null ? null : clampOne(body, BODY_MAX) }
}

export function parsePersonaJson(text: string): { headline: string; body: string | null } | null {
  const attempt = (s: string) => {
    try {
      const o = JSON.parse(s)
      if (o && typeof o.headline === 'string') {
        return { headline: o.headline, body: typeof o.body === 'string' ? o.body : null }
      }
    } catch { /* fall through */ }
    return null
  }
  const first = attempt(text)
  if (first) return first
  const m = text.match(/\{[\s\S]*\}/)
  return m ? attempt(m[0]) : null
}

export function richness(i: SummaryInput, _role: SummaryRole): number {
  return (i.releaseNote ? 2 : 0)
    + i.labels.length
    + i.linkedIssueTitles.length
    + (i.noteTechnical ? 1 : 0)
    + (i.prTitle.trim().split(/\s+/).length >= 4 ? 1 : 0)
}

export function stripPrSuffix(t: string): string {
  return t.trim().replace(/\s*\(#\d+\)$/, '')
}
