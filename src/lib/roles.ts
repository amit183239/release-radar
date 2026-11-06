/**
 * Role registry (config-driven personas). One entry per role; the picker,
 * Settings, changelog filter and insights all read from here, so adding a role
 * is a single entry — no code changes elsewhere. Replaces the hard-coded dev|cx
 * lens. Pure + unit-tested.
 */
export type Voice = 'technical' | 'customer'
export type Grouping = 'release' | 'milestone'

/** A note passes when the filter matches. Empty filter (developer) => all pass.
 *  `allOf` switches customerFacing+anyLabels from OR (default) to AND (sales). */
export interface RoleFilter {
  customerFacing?: boolean
  anyLabels?: string[]
  allOf?: boolean
}

/** Which insight cards + highlight query a role wants (see src/lib/insights.ts). */
export interface InsightsSpec {
  cards: string[]
  highlights: string
}

export interface RoleDef {
  key: string
  label: string
  blurb: string
  voice: Voice
  filter: RoleFilter
  grouping: Grouping
  insights: InsightsSpec
}

export const ROLES: RoleDef[] = [
  {
    key: 'developer',
    label: 'Developer',
    blurb: 'Every shipped PR with technical notes, divergent-release badges and PR links.',
    voice: 'technical',
    filter: {},
    grouping: 'release',
    insights: { cards: ['prs', 'releases', 'divergent', 'breaking'], highlights: 'active_apps' },
  },
  {
    key: 'cx',
    label: 'Customer Success',
    blurb: 'Customer-facing changes only, in plain language, with resolved customer issues.',
    voice: 'customer',
    filter: { customerFacing: true },
    grouping: 'release',
    insights: { cards: ['customer_facing', 'issues_resolved', 'apps_impact', 'ai_summarized'], highlights: 'customer_changes' },
  },
  {
    key: 'support',
    label: 'Support',
    blurb: 'Bugs, regressions and breaking changes to watch, with issue linkage.',
    voice: 'technical',
    filter: { customerFacing: true, anyLabels: ['bug', 'regression', 'breaking-change'] },
    grouping: 'release',
    insights: { cards: ['bugs', 'regressions', 'breaking', 'issues_resolved'], highlights: 'breaking_and_regressions' },
  },
  {
    key: 'sales',
    label: 'Sales & Marketing',
    blurb: 'New features and enhancements only — the highlights worth talking about.',
    voice: 'customer',
    filter: { customerFacing: true, anyLabels: ['feature', 'enhancement'], allOf: true },
    grouping: 'release',
    insights: { cards: ['features', 'enhancements', 'apps_impact', 'talking_points'], highlights: 'talking_points' },
  },
  {
    key: 'pm',
    label: 'Product Manager',
    blurb: 'Customer-facing plus notable internal work, framed by milestone.',
    voice: 'customer',
    filter: { customerFacing: true, anyLabels: ['feature', 'enhancement', 'breaking-change'] },
    grouping: 'release', // 'milestone' is the tracked fast-follow (needs entities.milestone populated)
    insights: { cards: ['prs_by_app', 'feature_fix_ratio', 'customer_facing', 'breaking'], highlights: 'themes' },
  },
]

export const DEFAULT_ROLE = 'developer'

const BY_KEY = new Map(ROLES.map((r) => [r.key, r]))

export function isRoleKey(v: string): boolean {
  return BY_KEY.has(v)
}

/** Resolve a stored role key, falling back to the default for unknown/null. */
export function getRole(key: string | null | undefined): RoleDef {
  return (key && BY_KEY.get(key)) || BY_KEY.get(DEFAULT_ROLE)!
}

/** True when a note is visible under a role's filter. Labels are lower-cased. */
export function noteMatchesRole(
  note: { customer_facing: number; labels: string[] },
  role: RoleDef
): boolean {
  const f = role.filter
  const hasCF = f.customerFacing === true
  const hasLabels = Array.isArray(f.anyLabels) && f.anyLabels.length > 0
  if (!hasCF && !hasLabels) return true // developer: no filter
  const wanted = new Set((f.anyLabels ?? []).map((l) => l.toLowerCase()))
  const cfOK = note.customer_facing === 1
  const labelOK = note.labels.some((l) => wanted.has(l.toLowerCase()))
  if (f.allOf) {
    return (!hasCF || cfOK) && (!hasLabels || labelOK)
  }
  // For OR roles, customerFacing is one OR-term among label match (not a required gate); only allOf roles (sales) require both.
  return (hasCF && cfOK) || (hasLabels && labelOK)
}
