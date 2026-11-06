/**
 * Off-tick persona summary generation. Runs on its own cron (every 15 min) off the
 * poll's critical path. For each PR lacking a dev (and optionally cx) summary,
 * generate via the AI provider — spend-capped and wall-budget-guarded per run,
 * idempotent per (release_id, pr_number, role) via the input_hash guard.
 *
 * When AI_PROVIDER=off: fast no-op — no summaries generated, zero egress.
 */
import type { Env } from '../env'
import type { AiProvider } from '../ai/provider'
import { makeAiProvider } from '../ai/provider'
import { resolveConfig } from '../config'
import { listPendingSummaries, missingRoles, upsertSummary, writeSummaryFallback } from '../lib/queries'
import { buildSummaryInput } from '../lib/summary-input'
import { hashSummaryInput } from '../lib/helpers'
import { richness, MIN_RICHNESS_DEV, MIN_RICHNESS_CX, PERSONA_SUMMARY_VERSION } from '../ai/persona-summaries'
import { capReached, addSpend, monthKey } from '../lib/ai-spend'
import { acquireLock, releaseLock } from '../lib/cron-locks'

const LOCK_TTL_SECONDS = 14 * 60 // < the 15-min cron interval; keep the key 'ai-notes'
const BATCH = 10
const WALL_BUDGET_MS = 700_000

export async function runAiSummaries(
  env: Env,
  opts: { now?: () => number; provider?: AiProvider } = {},
): Promise<{ generated: number; callsDeveloper: number; callsCx: number; spentCents: number } | { skipped: string }> {
  const provider = opts.provider ?? makeAiProvider(env)
  if (provider.id === 'off') return { skipped: 'off' }
  const cfg = resolveConfig(env)
  const now = opts.now ?? (() => Date.now())
  const db = env.DB

  // Acquire the same 'ai-notes' lock key (renaming orphans a pre-deploy lock row).
  const lock = await acquireLock(db, 'ai-notes', LOCK_TTL_SECONDS)
  if (!lock.acquired) return { skipped: 'locked' }

  try {
    if (await capReached(db, cfg.aiMonthlyCapCents)) {
      console.warn('[ai-summaries] monthly spend cap reached — skipping', {
        capCents: cfg.aiMonthlyCapCents,
      })
      return { skipped: 'capped' }
    }

    const startMs = now()
    let callsDeveloper = 0, callsCx = 0, spentCents = 0
    const pending = await listPendingSummaries(db, BATCH)

    for (const pr of pending) {
      if (now() - startMs > WALL_BUDGET_MS) break
      const missing = await missingRoles(db, { releaseId: pr.release_id, prNumber: pr.pr_number, customerFacing: pr.customer_facing === 1 })
      for (const role of missing) {
        if (now() - startMs > WALL_BUDGET_MS) return { generated: callsDeveloper + callsCx, callsDeveloper, callsCx, spentCents }
        if (await capReached(db, cfg.aiMonthlyCapCents)) return { generated: callsDeveloper + callsCx, callsDeveloper, callsCx, spentCents }
        const input = await buildSummaryInput(db, { repo: cfg.ownerRepo, app: pr.app, prNumber: pr.pr_number, role, noteTechnical: pr.note_technical })
        const hash = await hashSummaryInput(input, PERSONA_SUMMARY_VERSION)
        const minScore = role === 'cx' ? MIN_RICHNESS_CX : MIN_RICHNESS_DEV
        if (richness(input, role) < minScore) {
          await writeSummaryFallback(db, { releaseId: pr.release_id, prNumber: pr.pr_number, role, prTitle: input.prTitle, inputHash: hash })
          continue
        }
        const result = await provider.generatePersonaSummary(input)
        if (!result) {
          // Provider error (transient 5xx / timeout) — write '' sentinel so this role
          // is re-selected on the next tick. Do NOT use the real hash here: that would
          // permanently pin it to the fallback (indistinguishable from a thin-input row).
          await writeSummaryFallback(db, { releaseId: pr.release_id, prNumber: pr.pr_number, role, prTitle: input.prTitle, inputHash: '' })
          continue
        }
        await upsertSummary(db, { releaseId: pr.release_id, prNumber: pr.pr_number, role, result, inputHash: hash })
        await addSpend(db, monthKey(), result.costCents)
        if (role === 'cx') callsCx++; else callsDeveloper++
        spentCents += result.costCents
      }
    }
    return { generated: callsDeveloper + callsCx, callsDeveloper, callsCx, spentCents }
  } finally {
    await releaseLock(db, 'ai-notes', lock.token!)
  }
}
