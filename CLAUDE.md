# Release Radar

A standalone, **poll-based** per-app release changelog for the `acme/monorepo`
GitHub monorepo, with a dual-persona (Dev + CX) read surface behind SSO. Cloudflare
Worker (Hono) + D1. Apache-2.0 (OSS intent).

## Architecture (v1 = scheduled poll)

- **Ingestion**: a Cloudflare cron (`0 * * * *`) drives a resumable poll that reads
  the GitHub API with a fine-grained read-only PAT. No GitHub App, no webhooks.
  Self-healing: every tick re-scans state; idempotent upserts make re-scans no-ops.
- **"Shipped" detection — chained tag attribution** (the net-new correctness core,
  `src/lib/tags.ts`): the repo publishes git tags only (no Releases). Per app, order
  prod tags by **tag-creation time** (`tagger.date` — the only monotonic deploy-order
  signal; the tagged commit's date is wrong for hotfixes off old branches), chain
  consecutive pairs, three-dot-`compare` each pair, and enumerate PRs by parsing the
  squash `(#N)` from each commit's **subject-line suffix** (anchored — avoids revert /
  body false positives).
- **App scoping — path-derivation** (`src/lib/app-scoping.ts`, Option B): no `app:*`
  labels exist, so scope by changed path against `.github/mapping.json` (fetched via
  the GitHub API, cached with an ETag). `apps/<family>/**` → that family; a lib named
  for a family → that family; any other/shared lib → the synthetic **`platform`**
  umbrella bucket. No NX graph dependency.
- **Auth**: OAuth SSO (OAuth2 + PKCE) behind an **`AuthProvider` seam** (OSS
  requirement — OAuth is impl #1). A config-driven **fail-closed domain gate**
  (`src/auth/provider.ts` `checkDomainGate`) admits only a **verified** email in an
  **allowed domain** (`ALLOWED_EMAIL_DOMAINS`, e.g. `example.com`).
- **Persistence**: D1 only (R2 ledger deferred — the poll's idempotent re-scan removes
  the audit-trail need).

## Stack & conventions (vendored from `apps/billing`)

- **Runtime**: Cloudflare Workers (Hono). Web Crypto only — no Node crypto.
- **IDs**: UUIDv4 via `newId()` (`ulid` isn't Workers-compatible).
- **Timestamps**: Unix epoch **seconds** (integer) in all DB columns.
- **Queries**: parameterized (`?`) only — never string interpolation.
- **Cron**: guarded by a `cron_locks` singleton (`src/lib/cron-locks.ts`).
- **Migrations**: `migrations/NNNN_*.sql`, applied by `wrangler d1 migrations apply`.
  `schema.sql` is a flat mirror — update it in the SAME commit as any new migration.
- **Config-not-constants (§6)**: repo, tag pattern, mapping path, allowed domain, and
  shared-lib bucket are all `[vars]` in `wrangler.*.toml` (`src/config.ts` resolves
  them). Never hardcode. Secrets via `wrangler secret put` / `.dev.vars`.

## Wrangler configs

- `wrangler.toml` — LOCAL DEV ONLY. `DEBUG=true`, localhost. Never deployed.
- `wrangler.production.toml` — prod (`DEBUG=false`, `release-radar.example.com`).
- `wrangler.sandbox.toml` — sandbox (sandbox zone).

`src/index.ts` refuses to serve if `DEBUG=true` ships with a non-localhost `APP_URL`,
or (when deployed) if `GITHUB_TOKEN` / `SESSION_ENCRYPTION_KEY` are unset.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit (strict) + tsc -p test/integration
npm test                 # vitest run (unit, src/test/**, better-sqlite3 D1 shim)
npm run test:integration # Miniflare/workerd real-D1 end-to-end (test/integration/**)
npm run dev              # wrangler dev (needs a real DB id + .dev.vars)
npm run db:migrate:local   # apply migrations to the local D1
npm run db:migrate:sandbox # apply migrations to the sandbox D1 (remote) — BEFORE deploy:sandbox
npm run build:frontend   # install + vite build the SPA into frontend/dist
npm run deploy           # predeploy builds the SPA, then wrangler deploy (prod)
```

The frontend is a separate Vite package under `frontend/` (`frontend/dev` proxies
`/api` + `/auth` to the Worker on :8787). Its `dist/` is gitignored and rebuilt by
`predeploy`; the Worker serves it through the `ASSETS` binding.

Before deploy: set the real `database_id` in each `wrangler.*.toml` and put the
secrets (`GITHUB_TOKEN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`,
`SESSION_ENCRYPTION_KEY`; optional `ADMIN_TOKEN` to enable token-gated
`POST /admin/poll` + `POST /admin/backfill` in deployed envs — `/admin/ai-summaries`
and `/admin/redrain` stay DEBUG-only). Var `CUSTOMER_FACING_ISSUE_TYPES`
(comma-separated, default empty) marks PRs that close an issue of that GitHub issue
type as customer-facing — **no effect unless the org uses GitHub issue types**
(it was null on the testbed); use `CUSTOMER_FACING_LABELS` otherwise.

## Key files

| File | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry — DEBUG guard + fetch/scheduled |
| `src/config.ts` | Config-not-constants resolver + tag-pattern → regex |
| `src/lib/github.ts` | GitHub GraphQL/REST client (tags, compare, content, PR search) |
| `src/lib/tags.ts` | **Chained tag attribution** (pure; the correctness core) |
| `src/lib/app-scoping.ts` | Path → app (Option B; shared-lib bucket) |
| `src/lib/queries.ts` | D1 idempotent upserts (apps, releases, notes, entities, sync_state) |
| `src/lib/cron-locks.ts` | Tick singleton guard |
| `src/jobs/poll.ts` | Steady-state tick (`runPoll` + `runPollWithSource`) |
| `src/jobs/backfill.ts` | Separate capped 90-day history bootstrap |
| `src/auth/*` | AuthProvider seam, OAuth impl, fail-closed gate, sessions |
| `src/routes/api.ts` | Gated read API (apps directory + per-app changelog + search) |
| `src/routes/follows.ts` | Follow CRUD API (Phase 2) |
| `src/routes/feed.ts` | Feed + in-app notifications API (Phase 2) |
| `src/lib/release-notes.ts` | Curated `## Release Note` extractor (● vs ○) |
| `src/lib/follows.ts` | Follow primitive queries |
| `src/lib/events.ts` | Ship-event ledger + feed fan-out + notifications |
| `src/test/fixtures/fixture-source.ts` | Offline PollSource for replay/testing |
| `src/jobs/attribute.ts` | `prefetchPair` + `attributePr` — shared poll/backfill PR attribution |
| `src/lib/sync-cursor.ts` | Timestamp sync cursors (`YYYY-MM-DDTHH:MM:SSZ`, `updated:>=`) |
| `src/lib/budget.ts` | `QueryBudget` — per-tick D1 query cap (800) |
| `src/lib/activity.ts` | Pure `detectActivity` (re-surface: state change / new comments) |
| `src/lib/search.ts` | `noteMatchesQuery` / `escapeLike` — one definition for search + query follows |
| `src/lib/admin-auth.ts` | Constant-time `ADMIN_TOKEN` check |
| `test/integration/` | Miniflare real-D1 end-to-end poll test |

## Testing

`npm test`. The pure correctness core (`tags`, `app-scoping`, `config`, the auth gate)
is unit-tested offline. The poll/backfill accept an injected `PollSource`
(`FixturePollSource`) so they can be exercised with zero network. `npm run
test:integration` runs the poll end-to-end on a real D1 in workerd
(`@cloudflare/vitest-pool-workers`), applying the real `migrations/` chain.

## Status (2026-11-04)

- **Phase 1 (core poll) — implemented**: standalone scaffold, wrangler split + DEBUG
  guard, D1 schema/migrations, `cron_locks`, config layer, GitHub client, chained tag
  attribution, path app-scoping, resumable poll, entity cache sync, OAuth SSO +
  fail-closed gate, separate backfill bootstrap, fixture/replay source. Typechecks,
  24 unit tests pass, `wrangler deploy --dry-run` builds.
- **Phase 2 (Dev changelog + follow/feed/search + in-app notifications) — backend
  implemented**: curated ● (`## Release Note` from PR body) vs ○ from-PR-title copy,
  with a never-downgrade upsert gate; the follow primitive {issue,pr,label,milestone,
  query,app} (CRUD API); an `events` ship-ledger + feed fan-out to followers of a
  shipped PR / its closed issues / labels / the app (deduped one-per-(user,event));
  feed + notifications API (list, unread badge, mark-read/all); text search over
  changelog notes. Migration `0002`. Typechecks, 30 tests pass, builds. Milestone/
  query follow matching and re-surface shipped in v1 TODOs (below).
- **Read-surface UI — built** (`frontend/`): a Vite + React SPA served by the Worker
  via the `ASSETS` binding (`run_worker_first`, SPA fallback). Sign-in gate, apps
  directory, per-app changelog (curated ● / from-PR-title ○ dots, divergent badge),
  Dev/CX lens toggle, feed + unread bell, follow/unfollow, and search — all on the
  gated API. `npm run build:frontend`; `predeploy` builds it before a Worker deploy.
- **Phase 3 (CX lens) — backend implemented**: an `AiProvider` seam with `off`
  (default; CX degrades to PR-title fallback, zero egress) + a guarded Anthropic
  impl; fail-closed `customer_facing` classification (`customer-facing` label set is
  config); off-tick AI-notes cron (`*/15`) that generates `note_customer`,
  spend-capped (`ai_spend` monthly ledger, `AI_MONTHLY_CAP_CENTS`) and idempotent
  per note; a lens toggle (`/api/me`, `PATCH /api/me/lens`) and CX-filtered changelog
  (`?lens=cx`). Enforces the no-external-egress invariant (copy only reaches the
  gated internal surface). Migration `0003`. Typechecks, 34 tests pass, builds.
- **v1 TODOs — implemented**: CX close-the-loop
  (`customer_facing` from closed issues' labels + issue types; `customer_ref`/`ticket_ref`
  on follows, shown on feed cards, "Copy for customer" for customer-voiced roles);
  milestone + query follows across fan-out / follow-backfill / read-time; re-surface as
  unread **activity** feed items (state change / new comments; first sighting and
  pre-0008 rows never emit); timestamp sync cursors (fixes same-day misses);
  per-tick D1 `QueryBudget` + per-pair `last_ref`; one `attributePr` for poll + backfill
  (backfill records events, no fan-out); token-gated admin; shared `clampInt`/
  `parseLabels`; `/api/issues` total; button a11y. Migration `0008`. 267 unit +
  1 integration (Miniflare D1) tests pass. The plan's "per-product CS digest" is met by the
  digest tab's per-app grouping.

## Build-time open items (from the plan)

- ~~Verify D1 SQLite `strftime('%G'/'%V')`~~ — checked against **local** D1 (miniflare;
  `sqlite_version()` is blocked there): `strftime('%G-W%V','2026-01-01')` → `2026-W01`.
  Prod D1 may differ; nothing uses it yet. **Rule:** if a weekly digest key is ever
  needed, compute ISO-week keys in JS unless verified on prod D1.
- Measure `customer_facing` precision on real PRs (needs prod data — still open).
- ~~Confirm OAuth `emailVerified`~~ — resolved: the field doesn't exist; the gate
  reads `emailVerified !== false` (fail-closed only on an explicit `false`).
- ~~Out-of-band `runBackfill` trigger~~ — `POST /admin/backfill` with
  `Authorization: Bearer <ADMIN_TOKEN>`.
- **Manual backfill re-run** (operator only): `DELETE FROM sync_state WHERE key LIKE
  'backfill:%'` then `POST /admin/backfill`. ⚠️ This reclassifies `customer_facing` for
  the whole window and can enqueue a burst of cx AI summaries (bounded by
  `AI_MONTHLY_CAP_CENTS`).
- **Follow-up:** `@cloudflare/vitest-pool-workers` is deprecated in favour of
  `@cloudflare/vitest-plugin`; migrate the integration test setup.

## Deploy runbook + rollback

- **Order — migration first, always:** `npm run db:migrate:sandbox` →
  `npm run deploy:sandbox` → verify a poll tick (`POST /admin/poll` with the bearer
  token, or wait for cron) → `npm run db:migrate:prod` → `npm run deploy`. Deploying a
  worker before migration `0008` makes every `upsertEntity` fail (`comments_count`
  missing) and the poll stops.
- **Expect** a one-time small burst of activity items on the first tick after `0008`:
  legacy date cursors normalize to `T00:00:00Z` with `updated:>=`, so items the old
  date-truncation bug skipped are re-read once.
- **Expect** a one-time extra AI spend: backfill now classifies `customer_facing` and
  prefers curated copy, so new cx persona summaries get enqueued (bounded by
  `AI_MONTHLY_CAP_CENTS`).
- **Rollback:** redeploy the previous worker and leave `0008` in place (its columns
  and partial index are additive; old code ignores them). If the old code rejects the
  new `…THH:MM:SSZ` cursor, also run
  `DELETE FROM sync_state WHERE key IN ('pr-search','issue-search')`.
  **Required on rollback:** the old worker renders `kind='activity'` rows as broken ship
  cards, so run
  `DELETE FROM feed WHERE event_id IN (SELECT id FROM events WHERE kind = 'activity')`
  (the same statement also clears a bad activity burst). On roll-forward, expect a
  one-time burst of "+N comments" items: `comments_count` baselines are stale from the
  rollback window.
