import { Hono } from 'hono'
import type { Env } from './env'
import authRoutes from './auth/routes'
import apiRoutes from './routes/api'
import followRoutes from './routes/follows'
import feedRoutes from './routes/feed'
import meRoutes from './routes/me'
import insightsRoutes from './routes/insights'
import issuesRoutes from './routes/issues'
import suggestRoutes from './routes/suggest'
import adminRoutes from './routes/admin'

/** The main Hono app: auth flow + gated read/follow/feed API + a health check. */
export const app = new Hono<{ Bindings: Env }>()

// Public: liveness probe (no auth, no DB).
app.get('/health', (c) => c.json({ ok: true, service: 'release-radar' }))

app.route('/', authRoutes)
app.route('/', apiRoutes)
app.route('/', followRoutes)
app.route('/', feedRoutes)
app.route('/', meRoutes)
app.route('/', insightsRoutes)
app.route('/', issuesRoutes)
app.route('/', suggestRoutes)
// Manual job triggers. Gated per-route inside the module: /admin/poll and
// /admin/backfill allow DEBUG or POST + `Authorization: Bearer <ADMIN_TOKEN>`;
// /admin/ai-summaries and /admin/redrain are DEBUG-only. Each route fail-closes,
// so mounting the module unconditionally is safe.
app.route('/', adminRoutes)

// SPA: any route not matched above (i.e. non-API navigation) is served from the
// static assets bundle. `not_found_handling = "single-page-application"` in
// wrangler makes unknown paths fall back to index.html so client routing works.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
