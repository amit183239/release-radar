/**
 * Worker environment bindings for release-radar.
 *
 * Everything under "Config (§6 config-not-constants)" is a plain [vars] value
 * in wrangler.*.toml — never a hardcoded constant — so an OSS adopter re-points
 * the tool at their own repo/domain without touching code. Secrets are set via
 * `wrangler secret put` (prod/sandbox) or `.dev.vars` (local).
 */
export interface Env {
  // --- Bindings ---
  DB: D1Database
  /** Static SPA assets (frontend/dist). Served by app.ts for non-API routes. */
  ASSETS: Fetcher

  // --- Runtime / deploy ---
  /** 'true' only in local dev. The boot guard in index.ts refuses to serve if
   *  DEBUG=true ships with a non-localhost APP_URL. */
  DEBUG?: string
  /** Frontend origin for post-login redirects and cookie scoping. */
  APP_URL: string

  // --- Config (§6 config-not-constants) ---
  /** owner/repo the poll reads, e.g. "acme/monorepo". */
  GITHUB_REPO: string
  /** Prod deploy tag glob with a literal `{app}` placeholder, e.g.
   *  "{app}-*-production". */
  RELEASE_TAG_PATTERN: string
  /** Repo-relative path to the path->app map, e.g. ".github/mapping.json". */
  MAPPING_JSON_PATH: string
  /** Comma-separated SSO allow-list of email domains (fail-closed), e.g.
   *  "example.com". */
  ALLOWED_EMAIL_DOMAINS: string
  /** Synthetic umbrella bucket slug for genuinely-shared/unmapped libs,
   *  default "shared"; e.g. "platform". */
  SHARED_LIB_BUCKET: string
  /** Backfill history window in days (string; parsed to int). */
  BACKFILL_DAYS: string
  /** AI copy provider: 'off' | 'gemini' | 'anthropic'. 'off' => Dev lens only,
   *  CX degrades to PR-title fallback (no external egress). Unknown values are
   *  normalised to 'off' (fail-safe). */
  AI_PROVIDER?: string
  /** Model override; falls back to the per-provider default when omitted.
   *  gemini default: gemini-2.5-flash. anthropic default: claude-haiku-4-5-20251001. */
  AI_MODEL?: string
  /** Monthly AI spend cap in whole cents (string; parsed). Default 500 ($5). */
  AI_MONTHLY_CAP_CENTS?: string
  /** Comma-separated labels that mark a PR customer-facing (fail-closed: empty
   *  => nothing is customer-facing by label). */
  CUSTOMER_FACING_LABELS?: string
  /** Comma-separated GitHub issue types (e.g. "Bug") whose closing PRs are
   *  customer-facing. Empty => off (fail-closed). No effect unless the org
   *  uses GitHub issue types. */
  CUSTOMER_FACING_ISSUE_TYPES?: string

  // --- Secrets ---
  /** Fine-grained, read-only, org-scoped GitHub PAT that drives the poll. */
  GITHUB_TOKEN: string
  /** AES-GCM key (base64) for encrypting OAuth tokens at rest. */
  SESSION_ENCRYPTION_KEY: string
  /** API key for AI_PROVIDER=anthropic. Optional — absent => AI degrades to off. */
  ANTHROPIC_API_KEY?: string
  /** API key for AI_PROVIDER=gemini. Optional — absent => AI degrades to off. */
  GEMINI_API_KEY?: string
  /** Optional bearer token for POST /admin/poll + /admin/backfill in deployed
   *  envs. Unset/empty => token path disabled (fail-closed). Not required by the
   *  index.ts deploy guard. */
  ADMIN_TOKEN?: string

  // --- OAuth SSO (first AuthProvider impl) ---
  OAUTH_API_URL: string
  OAUTH_UI_URL: string
  OAUTH_CLIENT_ID: string
  OAUTH_CLIENT_SECRET: string
}
