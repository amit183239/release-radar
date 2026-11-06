/**
 * AI-provider seam (§6, second required OSS seam). CX customer copy is generated
 * through an `AiProvider` with an `off` mode:
 *   - `off`  => generateCustomerNote returns null; the Dev lens is unaffected and
 *               the CX lens degrades to the from-PR-title fallback. Zero egress.
 *   - others => concrete impls (Gemini below; Anthropic available via config).
 *
 * NO-EXTERNAL-EGRESS INVARIANT (§3/§8): this seam only *generates* copy for the
 * internal, SSO-gated surface. It never sends anything to a customer. Calling the
 * model provider is internal generation, not customer egress.
 */
import type { Env } from '../env'
import { resolveAiConfig } from '../config'
import {
  parsePersonaJson, clampSummary,
  type SummaryInput, type SummaryResult,
} from './persona-summaries'

export interface GenerateInput {
  app: string
  prTitle: string
  noteTechnical: string | null
}

export interface GenerateResult {
  text: string
  /** Estimated cost in whole cents, recorded against the monthly spend cap. */
  costCents: number
}

export interface AiProvider {
  readonly id: string
  /**
   * @deprecated Use generatePersonaSummary instead.
   * null => no copy produced (off, declined, or error) — caller falls back.
   */
  generateCustomerNote(input: GenerateInput): Promise<GenerateResult | null>
  /** null => caller writes a fallback row (off, error, or JSON-parse failure). */
  generatePersonaSummary(input: SummaryInput): Promise<SummaryResult | null>
}

/** The default: AI disabled. CX copy falls back to the PR title. */
export class OffAiProvider implements AiProvider {
  readonly id = 'off'
  async generateCustomerNote(): Promise<GenerateResult | null> {
    return null
  }
  async generatePersonaSummary(): Promise<SummaryResult | null> {
    return null
  }
}

// ---------------------------------------------------------------------------
// Shared prompt helpers (used by both Anthropic and Gemini impls)
// ---------------------------------------------------------------------------

const SYSTEM_PREAMBLE =
  'You write release-feed summaries for an internal tool at a martech company. You receive structured ' +
  'facts about one shipped pull request. Reply ONLY with a JSON object {"headline": string, "body": ' +
  'string|null}. No prose, no markdown, no code fences. Never invent facts not present in the inputs. ' +
  'Never include PR numbers, code identifiers, file paths, or ticket IDs. If the inputs are too thin to say ' +
  'anything specific, set body to null and make headline a faithful restatement of the title.'

const ROLE_PROMPT: Record<SummaryInput['role'], string> = {
  developer:
    'ROLE: developer. Write for an engineer skimming what shipped. headline (<=80 chars): what changed, in ' +
    "the doer's active voice, e.g. \"Adds a sharing toolkit for billing advertisers\". body (<=240 chars, " +
    'optional): the technically-relevant so-what — the mechanism, surface, or follow-on an engineer cares ' +
    'about. Keep domain terms; do not dumb it down. Omit body if the headline says it all.',
  cx:
    'ROLE: customer success. Write for a non-technical CX agent who must explain this to a customer. headline ' +
    '(<=80 chars): the customer-visible benefit in plain language — WHAT they can now do. body (<=240 chars, ' +
    "optional): WHY it helps and HOW they'd use it, from the customer's point of view. No jargon, no internal " +
    'system names unless customer-facing. If there is no plausible customer impact, set body to null and keep ' +
    'the headline factual and neutral. Do not manufacture a benefit the inputs do not support.',
}

function userMessage(i: SummaryInput): string {
  const lines = [
    `App: ${i.app}`,
    `PR title: ${i.prTitle}`,
    `Release note: ${i.releaseNote ?? '(none)'}`,
    `Labels: ${i.labels.join(', ') || '(none)'}`,
    `Resolved issues: ${i.linkedIssueTitles.join(' | ') || '(none)'}`,
  ]
  if (i.noteTechnical && i.noteTechnical !== i.prTitle) lines.push(`Technical note: ${i.noteTechnical}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Legacy SYSTEM_PROMPT for generateCustomerNote (kept for backward compat)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You rewrite a developer pull-request title into one plain-language sentence a ' +
  'non-technical customer-support agent can understand. No jargon, no PR numbers, ' +
  'no code identifiers. Describe the user-visible effect. Reply with the sentence only.'

/** Anthropic-backed impl. Guarded: returns null if no API key is configured,
 *  so it degrades exactly like `off`. */
export class AnthropicAiProvider implements AiProvider {
  readonly id = 'anthropic'
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string = 'claude-haiku-4-5-20251001',
  ) {}

  /**
   * @deprecated Use generatePersonaSummary instead.
   */
  async generateCustomerNote(input: GenerateInput): Promise<GenerateResult | null> {
    if (!this.apiKey) {
      console.warn('[ai] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY unset — degrading to fallback')
      return null
    }
    const prompt = `App: ${input.app}\nPR title: ${input.prTitle}\nTechnical note: ${
      input.noteTechnical ?? '(none)'
    }`
    let res: Response
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 120,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (e) {
      console.warn('[ai] request failed:', typeof e)
      return null
    }
    if (!res.ok) {
      console.warn('[ai] non-OK response:', res.status)
      return null
    }
    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
      usage?: { input_tokens: number; output_tokens: number }
    }
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim()
    if (!text) return null
    return { text, costCents: estimateCents(this.model, body.usage?.input_tokens ?? 0, body.usage?.output_tokens ?? 0) }
  }

  async generatePersonaSummary(input: SummaryInput): Promise<SummaryResult | null> {
    if (!this.apiKey) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          system: `${SYSTEM_PREAMBLE}\n\n${ROLE_PROMPT[input.role]}`,
          messages: [{ role: 'user', content: userMessage(input) }],
        }),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const data: any = await res.json()
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      const parsed = parsePersonaJson(text)
      if (!parsed) return null
      const { headline, body } = clampSummary(parsed.headline, parsed.body)
      const inTok = data.usage?.input_tokens ?? 0
      const outTok = data.usage?.output_tokens ?? 0
      return { headline, body, costCents: estimateCents(this.model, inTok, outTok) }
    } catch { return null } finally { clearTimeout(timer) }
  }
}

/** Gemini-backed impl (default provider). Guarded: returns null if no API key
 *  is configured, so it degrades exactly like `off`. */
export class GeminiAiProvider implements AiProvider {
  readonly id = 'gemini'
  constructor(private apiKey: string | undefined, private model: string) {}
  /** @deprecated Use generatePersonaSummary instead. Unused by the drainer. */
  async generateCustomerNote(): Promise<GenerateResult | null> { return null }
  async generatePersonaSummary(input: SummaryInput): Promise<SummaryResult | null> {
    if (!this.apiKey) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: `${SYSTEM_PREAMBLE}\n\n${ROLE_PROMPT[input.role]}` }] },
          contents: [{ role: 'user', parts: [{ text: userMessage(input) }] }],
          // gemini-2.5-* are reasoning models: with thinking ON, the model spends
          // maxOutputTokens on "thoughts" first, so a realistic (longer) prompt hits
          // MAX_TOKENS before emitting the JSON → empty text → fallback every time.
          // A structured rewrite needs no reasoning, so disable it (thinkingBudget: 0);
          // 200 output tokens then comfortably fits headline(<=80c)+body(<=240c).
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 200,
            temperature: 0.2,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const data: any = await res.json()
      if (data.promptFeedback?.blockReason) return null
      if (!data.candidates?.length) return null
      const parts = data.candidates[0]?.content?.parts ?? []
      const text = parts.map((p: any) => p.text ?? '').join('')
      const parsed = parsePersonaJson(text)
      if (!parsed) return null
      const { headline, body } = clampSummary(parsed.headline, parsed.body)
      const inTok = data.usageMetadata?.promptTokenCount ?? 0
      const outTok = data.usageMetadata?.candidatesTokenCount ?? 0
      return { headline, body, costCents: estimateCents(this.model, inTok, outTok) }
    } catch { return null } finally { clearTimeout(timer) }
  }
}

// ---------------------------------------------------------------------------
// Per-model cost estimator
// ---------------------------------------------------------------------------

const RATES: Array<{ prefix: string; inPer1k: number; outPer1k: number }> = [
  { prefix: 'gemini-2.5-flash', inPer1k: 0.0075, outPer1k: 0.03 },
  { prefix: 'gemini-2.5-pro',   inPer1k: 0.0125, outPer1k: 0.05 },
  { prefix: 'gemini-2.0-flash', inPer1k: 0.0075, outPer1k: 0.03 },
  { prefix: 'claude-haiku',     inPer1k: 0.08,   outPer1k: 0.40 },
]

export function estimateCents(model: string, inTok: number, outTok: number): number {
  const r = RATES.find((x) => model.startsWith(x.prefix)) ?? { inPer1k: 0.1, outPer1k: 0.4 }
  const cents = (inTok / 1000) * r.inPer1k + (outTok / 1000) * r.outPer1k
  // 1¢ floor: with 2 calls/PR this is ≥2¢/PR in the ledger vs sub-cent real (~10-15× conservative).
  // Intentional — do not "fix" the floor away. Size AI_MONTHLY_CAP_CENTS against the ledger.
  return Math.max(1, Math.ceil(cents))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeAiProvider(env: Env): AiProvider {
  // Delegate to resolveAiConfig — the single source of truth for the DEFAULT_MODEL
  // map and provider normalisation. Safe to call with a minimal env (no RELEASE_TAG_PATTERN
  // etc. required). For full config validation use resolveConfig(env) at request/tick entry.
  const { aiProvider, aiModel } = resolveAiConfig(env)
  switch (aiProvider) {
    case 'gemini':    return new GeminiAiProvider(env.GEMINI_API_KEY, aiModel)
    case 'anthropic': return new AnthropicAiProvider(env.ANTHROPIC_API_KEY, aiModel)
    default:          return new OffAiProvider()
  }
}

