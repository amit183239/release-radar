/**
 * App scoping — path-derivation PRIMARY (§2, review V1). There are no `app:*`
 * labels in the repo, so a release's app(s) are derived from its changed file
 * paths against `.github/mapping.json` (authoritative project->path map).
 *
 * Shared-lib fan-out is Option B (path-only, no NX graph):
 *   1. `apps/<family>/**`               -> app `<family>`
 *   2. `libs/**` whose 3rd segment names a known app family -> that family
 *   3. any other/unmapped `libs/**` or root path -> the synthetic shared bucket
 *      (e.g. "platform"). Known trade-off: library-heavy change buckets
 *      coarsely under the umbrella until true graph fan-out (Option A) lands.
 *
 * Pure functions only — testable offline against a fixture mapping.json.
 */

/** Parsed mapping.json shape: `{ projects: { <nx-slug>: <repo-path> } }`. */
export interface Mapping {
  projects: Record<string, string>
}

/** A derived app family: the `apps/<family>` grouping the changelog keys on. */
export interface AppFamily {
  slug: string
  /** Path prefixes (from mapping.json) owned by this family, for display/audit. */
  paths: string[]
}

export function parseMapping(text: string): Mapping {
  const parsed = JSON.parse(text) as unknown
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { projects?: unknown }).projects !== 'object'
  ) {
    throw new Error('mapping.json missing a `projects` object')
  }
  return parsed as Mapping
}

/**
 * Derive the set of app families from a mapping. A "family" is the second path
 * segment of any `apps/<family>/...` entry (e.g. apps/billing/backend ->
 * "billing", apps/platform/app-api -> "platform"). Single-segment app paths
 * (apps/search) are their own family.
 */
export function deriveFamilies(mapping: Mapping): AppFamily[] {
  const byFamily = new Map<string, Set<string>>()
  for (const path of Object.values(mapping.projects)) {
    const segs = path.split('/')
    if (segs[0] !== 'apps' || segs.length < 2) continue
    const family = segs[1]!
    if (!byFamily.has(family)) byFamily.set(family, new Set())
    byFamily.get(family)!.add(path)
  }
  return [...byFamily.entries()]
    .map(([slug, paths]) => ({ slug, paths: [...paths].sort() }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

/**
 * Resolve a single changed file path to its owning app slug (or the shared
 * bucket). `families` is the set of known app-family slugs from deriveFamilies.
 */
export function scopePath(
  path: string,
  families: Set<string>,
  sharedBucket: string
): string {
  const segs = path.split('/')
  // 1. apps/<family>/** -> that family (only if it's a real family).
  if (segs[0] === 'apps' && segs.length >= 2 && families.has(segs[1]!)) {
    return segs[1]!
  }
  // 2. libs/providers/<name>/** or libs/<name>/** -> owning family if named.
  if (segs[0] === 'libs' && segs.length >= 2) {
    // Try the deepest-to-shallowest segment that names a family.
    for (let i = Math.min(segs.length - 1, 3); i >= 1; i--) {
      const candidate = segs[i]!
      if (families.has(candidate)) return candidate
    }
  }
  // 3. everything else (unmapped libs, root configs, .github, docs) -> shared.
  return sharedBucket
}

/**
 * Union the owning app slugs across all changed files in a release. Returns a
 * sorted, de-duplicated list. An empty `files` (e.g. a truncated/empty compare)
 * yields just the shared bucket so the release is never silently unscoped.
 */
export function scopeFilesToApps(
  files: string[],
  families: Set<string>,
  sharedBucket: string
): string[] {
  const apps = new Set<string>()
  for (const f of files) apps.add(scopePath(f, families, sharedBucket))
  if (apps.size === 0) apps.add(sharedBucket)
  return [...apps].sort()
}

/**
 * Does a PR (by its changed file paths) belong to `appSlug`? True iff appSlug is
 * one of the app families the PR's files scope to. Empty files scope to the
 * shared bucket only (see scopeFilesToApps).
 */
export function prScopesToApp(
  prFiles: string[],
  appSlug: string,
  families: Set<string>,
  sharedBucket: string
): boolean {
  return scopeFilesToApps(prFiles, families, sharedBucket).includes(appSlug)
}
