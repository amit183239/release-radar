import type { Env } from './env'

/**
 * Resolved, validated configuration derived from Env [vars] (§6
 * config-not-constants). Centralizes every "point at a different repo/domain"
 * knob so nothing downstream hardcodes `acme/monorepo`, the tag pattern,
 * the mapping path, the allowed domain, or the shared-lib bucket name.
 */
export interface AppConfig {
  /** GitHub repo owner, e.g. "acme". */
  owner: string
  /** GitHub repo name, e.g. "solutions". */
  repo: string
  /** "owner/repo" for logging / GraphQL `repo:` filters. */
  ownerRepo: string
  /** Repo-relative path of the path->app map. */
  mappingPath: string
  /** Lower-cased email domains allowed to sign in (fail-closed on empty). */
  allowedDomains: string[]
  /** Synthetic umbrella bucket slug for unmapped shared libs. */
  sharedLibBucket: string
  /** Backfill window in days (>= 1). */
  backfillDays: number
  /** AI provider id; 'off' disables all AI copy generation. */
  aiProvider: 'off' | 'gemini' | 'anthropic'
  /** Model name to use for AI copy generation; empty string when aiProvider is 'off'. */
  aiModel: string
  /** Monthly AI spend cap in whole cents. */
  aiMonthlyCapCents: number
  /** Labels that mark a PR customer-facing (lower-cased; may be empty). */
  customerFacingLabels: string[]
  /** Issue types that mark a closing PR customer-facing (lower-cased; may be empty). */
  customerFacingIssueTypes: string[]
  /** Raw tag pattern with the `{app}` placeholder, e.g. "{app}-*-production". */
  tagPattern: string
}

class ConfigError extends Error {}

function requireVar(env: Env, key: keyof Env): string {
  const v = env[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConfigError(`Missing required config var: ${String(key)}`)
  }
  return v.trim()
}

/**
 * Resolve ONLY the AI provider + model from Env, with no guards on unrelated vars.
 * Single source of truth for the DEFAULT_MODEL map. Safe to call with a minimal env
 * (e.g. from `makeAiProvider` in tests that don't supply RELEASE_TAG_PATTERN etc.).
 * `resolveConfig` calls this internally — the map lives here only.
 */
export function resolveAiConfig(
  env: Pick<Env, 'AI_PROVIDER' | 'AI_MODEL'>,
): { aiProvider: 'off' | 'gemini' | 'anthropic'; aiModel: string } {
  const rawProvider = (env.AI_PROVIDER ?? 'off').toLowerCase()
  const aiProvider: 'off' | 'gemini' | 'anthropic' =
    rawProvider === 'gemini' || rawProvider === 'anthropic' ? rawProvider : 'off'
  const DEFAULT_MODEL: Record<'gemini' | 'anthropic', string> = {
    gemini: 'gemini-2.5-flash',
    anthropic: 'claude-haiku-4-5-20251001',
  }
  const aiModel =
    (env.AI_MODEL && env.AI_MODEL.trim()) ||
    (aiProvider === 'off' ? '' : DEFAULT_MODEL[aiProvider])
  return { aiProvider, aiModel }
}

/**
 * Build the AppConfig from Env, failing loudly on missing/invalid values.
 * Call once per request/tick and thread the result; it does no I/O.
 */
export function resolveConfig(env: Env): AppConfig {
  const ownerRepo = requireVar(env, 'GITHUB_REPO')
  const slash = ownerRepo.indexOf('/')
  if (slash <= 0 || slash === ownerRepo.length - 1) {
    throw new ConfigError(
      `GITHUB_REPO must be "owner/repo", got: ${ownerRepo}`
    )
  }
  const owner = ownerRepo.slice(0, slash)
  const repo = ownerRepo.slice(slash + 1)

  const tagPattern = requireVar(env, 'RELEASE_TAG_PATTERN')
  if (!tagPattern.includes('{app}')) {
    throw new ConfigError(
      `RELEASE_TAG_PATTERN must contain the {app} placeholder, got: ${tagPattern}`
    )
  }

  const allowedDomains = requireVar(env, 'ALLOWED_EMAIL_DOMAINS')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0)
  if (allowedDomains.length === 0) {
    // Fail closed: an empty allow-list must never mean "allow everyone".
    throw new ConfigError('ALLOWED_EMAIL_DOMAINS resolved to an empty list')
  }

  const backfillDays = Number.parseInt(requireVar(env, 'BACKFILL_DAYS'), 10)
  if (!Number.isFinite(backfillDays) || backfillDays < 1) {
    throw new ConfigError(
      `BACKFILL_DAYS must be a positive integer, got: ${env.BACKFILL_DAYS}`
    )
  }

  const { aiProvider, aiModel } = resolveAiConfig(env)

  return {
    owner,
    repo,
    ownerRepo,
    mappingPath: requireVar(env, 'MAPPING_JSON_PATH'),
    allowedDomains,
    sharedLibBucket: requireVar(env, 'SHARED_LIB_BUCKET'),
    backfillDays,
    aiProvider,
    aiModel,
    aiMonthlyCapCents: parseCapCents(env.AI_MONTHLY_CAP_CENTS),
    customerFacingLabels: (env.CUSTOMER_FACING_LABELS ?? '')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0),
    customerFacingIssueTypes: (env.CUSTOMER_FACING_ISSUE_TYPES ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0),
    tagPattern,
  }
}

/** Monthly AI cap in cents; default 500 ($5), floor 0 (0 => disabled). */
function parseCapCents(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 0) return 500
  return n
}

/**
 * Escape a string for literal use inside a RegExp. `{app}` is substituted
 * BEFORE calling this, so the app slug is escaped too.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile the configured tag pattern into a RegExp for one app slug.
 * `*` in the pattern becomes `.*` (a glob wildcard); every other character is
 * matched literally. Anchored both ends so a partial tag can't match.
 *
 * e.g. app="billing", pattern="{app}-*-production"
 *   => /^billing-.*-production$/
 */
export function tagRegexForApp(pattern: string, app: string): RegExp {
  const withApp = pattern.split('{app}').join(app)
  const compiled = withApp
    .split('*')
    .map(escapeRegExp)
    .join('.*')
  return new RegExp(`^${compiled}$`)
}

/**
 * Compile the tag pattern into a RegExp that matches ANY app's prod tag and
 * captures the app slug in group 1. Used by the org-wide tag sweep to bucket
 * tags by app in one pass.
 *
 * e.g. pattern="{app}-*-production" => /^(.+?)-.*-production$/
 * The `{app}` group is non-greedy so the first hyphenated segment wins.
 */
export function tagRegexAnyApp(pattern: string): RegExp {
  const parts = pattern.split('{app}')
  const compiled = parts
    .map((p) => p.split('*').map(escapeRegExp).join('.*'))
    .join('(.+?)')
  return new RegExp(`^${compiled}$`)
}
