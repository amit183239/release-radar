import type { Env } from './env'
import { runPoll } from './jobs/poll'
import { runAiSummaries } from './jobs/ai-summaries'

/**
 * Cron dispatcher. Hourly = the steady-state poll; every 15 min = off-tick
 * persona summary generation (a no-op when AI_PROVIDER=off). Errors are caught
 * + logged (never thrown) so one failing tick doesn't wedge the schedule; both
 * jobs are self-healing / idempotent and resume next tick.
 */
export async function handleCron(
  event: ScheduledEvent,
  env: Env
): Promise<void> {
  switch (event.cron) {
    case '0 * * * *': {
      console.log('[cron] poll starting…')
      try {
        const result = await runPoll(env)
        console.log('[cron] poll done:', JSON.stringify(result))
      } catch (err) {
        console.error('[cron:poll] failed:', err)
      }
      break
    }
    case '*/15 * * * *': {
      try {
        const result = await runAiSummaries(env)
        console.log('[cron] ai-summaries done:', JSON.stringify(result))
      } catch (err) {
        console.error('[cron:ai-summaries] failed:', err)
      }
      break
    }
    default:
      console.warn(`[cron] no handler for schedule: ${event.cron}`)
  }
}
