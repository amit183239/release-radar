import { app } from './app'
import { handleCron } from './cron'
import type { Env } from './env'

/**
 * Deploy-time sanity guard. DEBUG=true relaxes
 * dev-only behaviour, so it must never ship with a non-localhost APP_URL. Also
 * fail closed on a deployed env missing the secrets the poll/auth need — better
 * a loud 500 at the edge than a silent half-broken deploy. Runs once per isolate.
 */
function assertDeployConfig(env: Env): string | null {
  if (env.DEBUG === 'true' && !env.APP_URL.startsWith('http://localhost')) {
    return `Refusing to serve: DEBUG=true with non-localhost APP_URL=${env.APP_URL}. Use wrangler.production.toml or wrangler.sandbox.toml.`
  }
  if (env.DEBUG !== 'true') {
    if (!env.GITHUB_TOKEN) {
      return 'Refusing to serve: GITHUB_TOKEN is unset (required for the poll).'
    }
    if (!env.SESSION_ENCRYPTION_KEY) {
      return 'Refusing to serve: SESSION_ENCRYPTION_KEY is unset (required to store sessions).'
    }
  }
  return null
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    const err = assertDeployConfig(env)
    if (err) {
      console.error(err)
      return new Response('Server misconfigured', { status: 500 })
    }
    return app.fetch(request, env, ctx)
  },
  scheduled: (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    const err = assertDeployConfig(env)
    if (err) {
      console.error(err)
      return
    }
    ctx.waitUntil(handleCron(event, env))
  },
}
